import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// The clips are written into the app's audio folder; point that somewhere
// writable BEFORE the modules that read it are imported.
const audioDir = join(tmpdir(), `feedback-sounds-${process.pid}`);
process.env.HE_AUDIO_DIR = audioDir;

const { ensureFeedbackSoundMp3, __resetFeedbackSoundCache } = await import('../src/helpers/feedback-sounds.mjs');
const { pcmToFlacBuffer, flacToPcmBuffer } = await import('../src/helpers/audio-encoders.mjs');
const { SOUND_URLS } = await import('../src/helpers/sound-urls.mjs');

/** A real 24 kHz mono FLAC, so the decode → resample → encode chain runs for real. */
async function sourceClip(seconds = 0.5): Promise<Buffer> {
    const samples = Math.round(24_000 * seconds);
    const pcm = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        pcm.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 24_000)), i * 2);
    }
    return pcmToFlacBuffer(pcm, { sampleRate: 24_000, channels: 1, bitsPerSample: 16 });
}

describe('ensureFeedbackSoundMp3', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
        __resetFeedbackSoundCache();
        await fs.mkdir(audioDir, { recursive: true });
        const flac = await sourceClip();
        fetchMock = vi.fn(async () => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => flac.buffer.slice(flac.byteOffset, flac.byteOffset + flac.byteLength),
        }));
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(async () => {
        vi.unstubAllGlobals();
        await fs.rm(audioDir, { recursive: true, force: true });
    });

    it('converts the clip to an MP3 in the audio folder', async () => {
        const sound = await ensureFeedbackSoundMp3('error');

        expect(fetchMock).toHaveBeenCalledWith(SOUND_URLS.error);
        expect(sound.filename).toBe('feedback_error.mp3');
        // 500 ms in, 500 ms reported — measured on the source, not the resample.
        expect(sound.durationMs).toBe(500);

        const written = await fs.readFile(join(audioDir, sound.filename));
        // MPEG-1 Layer III frame sync.
        expect(written[0]).toBe(0xff);
        expect(written[1] & 0xfe).toBe(0xfa);
    });

    it('lifts the clip to 48 kHz like the rest of the Flow-URL path', async () => {
        // Network players are only really tested at 44.1/48 kHz; our clips are
        // 24 kHz, so re-decoding the result must show twice the samples.
        await ensureFeedbackSoundMp3('error');
        const flac = await sourceClip();
        const source = await flacToPcmBuffer(flac);
        expect(source.sampleRate).toBe(24_000);

        const written = await fs.readFile(join(audioDir, 'feedback_error.mp3'));
        // 500 ms of 48 kHz mono at 128 kbit/s ≈ 8 KB; at 24 kHz it would be half
        // the frames. Checked as a floor so encoder padding can't make it flaky.
        expect(written.length).toBeGreaterThan(6_000);
    });

    it('converts each clip once per boot', async () => {
        const first = await ensureFeedbackSoundMp3('error');
        const second = await ensureFeedbackSoundMp3('error');

        expect(second).toEqual(first);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('keeps clips apart', async () => {
        const error = await ensureFeedbackSoundMp3('error');
        const connected = await ensureFeedbackSoundMp3('device_connected');

        expect(connected.filename).not.toBe(error.filename);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries after a failed fetch instead of caching the failure', async () => {
        fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as any);

        await expect(ensureFeedbackSoundMp3('error')).rejects.toThrow(/HTTP 503/);
        // A WAN hiccup must not disable the sound for the rest of the boot.
        await expect(ensureFeedbackSoundMp3('error')).resolves.toMatchObject({
            filename: 'feedback_error.mp3',
        });
    });
});
