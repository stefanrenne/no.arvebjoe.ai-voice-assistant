import { promises as fs } from 'fs';
import { flacToPcmBuffer, pcmToMp3Buffer } from './audio-encoders.mjs';
import { resamplePcm16Mono } from './wav.mjs';
import { audioFilePath } from './file-helper.mjs';
import { SOUND_URLS, SoundUrlKey } from './sound-urls.mjs';
import { createLogger } from './logger.mjs';

const log = createLogger('SOUNDS', true);

/**
 * Rate the MP3 copies are encoded at, matching the Flow-URL reply path: the
 * documented/tested FLAC rates on network players are 44.1/48 kHz and our
 * clips are 24 kHz, so everything handed to a Flow is lifted to 48 kHz.
 */
const FLOW_SAMPLE_RATE = 48_000;

export interface FeedbackSoundFile {
    /** File in the app's audio folder; the caller builds the LAN URL from it. */
    filename: string;
    /** Length of the clip, from the decoded source. */
    durationMs: number;
}

/**
 * The pre-recorded feedback clips (`sound-urls.mts`) as MP3s served from Homey.
 *
 * A satellite plays the FLAC original straight from GitHub — ESPHome compiles in
 * only the decoders its `format:` option asks for and these firmwares are built
 * for FLAC, which is also why the *Playback audio from URL* Flow card says "as
 * long as it's flac format". A device that routes its reply audio to a Flow has
 * no speaker of its own to play them on, so the clip goes out as a URL instead —
 * and there the audience is a third-party speaker, where MP3 is the one format
 * everything plays.
 *
 * So the clip is fetched once, decoded, and re-encoded with the same MP3 encoder
 * the reply path uses. The result is written to the audio folder under a stable
 * name and kept for the rest of the boot (like the chimes, and unlike per-turn
 * reply files it gets no scheduled deletion) — a handful of KB that saves a WAN
 * round trip and an encode on every later error.
 */
const ready = new Map<SoundUrlKey, Promise<FeedbackSoundFile>>();

/** Reset the per-boot cache. Tests only. */
export function __resetFeedbackSoundCache(): void {
    ready.clear();
}

export function ensureFeedbackSoundMp3(key: SoundUrlKey): Promise<FeedbackSoundFile> {
    let pending = ready.get(key);
    if (!pending) {
        pending = buildFeedbackSoundMp3(key).catch((err) => {
            // Drop the failed attempt so the next error sound retries — the usual
            // cause is a WAN hiccup fetching the clip, which fixes itself.
            ready.delete(key);
            throw err;
        });
        ready.set(key, pending);
    }
    return pending;
}

/**
 * Build every clip up front, sequentially. The lazy path pays a WAN fetch plus a
 * decode and an MP3 encode on FIRST use, and first use is the worst possible
 * moment for it: for the wake chime it lands inside the wake the user is waiting
 * on, and for the error clips it lands exactly when the network is already
 * unhappy — which is why they are being played at all. Never rejects; a clip
 * that fails here is simply rebuilt (and re-reported) on first real use.
 */
export async function prewarmFeedbackSounds(
    onError?: (key: SoundUrlKey, err: unknown) => void
): Promise<void> {
    for (const key of Object.keys(SOUND_URLS) as SoundUrlKey[]) {
        try {
            await ensureFeedbackSoundMp3(key);
        } catch (err) {
            onError?.(key, err);
        }
    }
}

async function buildFeedbackSoundMp3(key: SoundUrlKey): Promise<FeedbackSoundFile> {
    const source = SOUND_URLS[key];
    const response = await fetch(source);
    if (!response.ok) {
        throw new Error(`Could not fetch ${source}: HTTP ${response.status}`);
    }
    const flac = Buffer.from(await response.arrayBuffer());

    const { pcm, sampleRate, channels } = await flacToPcmBuffer(flac);
    // Measured on the source, so resampling can't change the number.
    const durationMs = Math.round((pcm.length / (2 * channels) / sampleRate) * 1000);

    // resamplePcm16Mono is mono-only; the clips all are, and a stereo one would
    // rather keep its own rate than be interleave-mangled.
    const shouldResample = channels === 1 && sampleRate !== FLOW_SAMPLE_RATE;
    const samples = shouldResample ? resamplePcm16Mono(pcm, sampleRate, FLOW_SAMPLE_RATE) : pcm;

    const mp3 = await pcmToMp3Buffer(samples, {
        sampleRate: shouldResample ? FLOW_SAMPLE_RATE : sampleRate,
        channels,
        bitsPerSample: 16,
    });

    const filename = `feedback_${key}.mp3`;
    await fs.writeFile(audioFilePath(filename), mp3);
    log.info(`Feedback sound converted: ${filename} (${mp3.length} bytes MP3, ${durationMs} ms)`);
    return { filename, durationMs };
}
