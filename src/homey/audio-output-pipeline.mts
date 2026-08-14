import { EventEmitter } from 'events';
import { TypedEmitter } from 'tiny-typed-emitter';
import { PcmSegmenter } from '../helpers/pcm-segmenter.mjs';
import { pcmToFlacBuffer, pcmToMp3Buffer } from '../helpers/audio-encoders.mjs';
import { scheduleAudioFileDeletion } from '../helpers/file-helper.mjs';
import { resamplePcm16Mono } from '../helpers/wav.mjs';
import { AudioData, FileInfo } from '../helpers/interfaces.mjs';

/** Sample rate the providers deliver reply PCM at, and the satellites play. */
const REPLY_SAMPLE_RATE = 24_000;

/** How a turn's reply leaves the device. Decided per turn at mic-open. */
export type ReplyMode = 'announce' | 'inband';

/** Container the reply file is encoded into. See buildReplyFile(). */
export type ReplyFormat = 'flac' | 'mp3';

type PipelineEvents = {
    /**
     * A finished announce segment, in strict FIFO order (H-l). action 'play'
     * means nothing else is playing — the device should play it now; 'queued'
     * means it waits behind the current announcement (announceFinished() will
     * hand it back when its turn comes).
     */
    segment: (d: { fileInfo: FileInfo; action: 'play' | 'queued' }) => void;
    /**
     * The provider's reply stream ended (segmenter flushed). In in-band mode the
     * accumulated reply PCM is handed over (and the mode resets to announce);
     * the device runs the TTS_END delivery protocol with it.
     *
     * `silent` on the announce path means the turn produced no reply audio at
     * all — no segment was ever built, so no announcement will ever be played
     * and no announce_finished will come back to end the run. The device must
     * close the turn itself (see the handler in voice-assistant-device.mts).
     * The in-band path needs no such flag: an empty pcm buffer says the same
     * thing and that branch already handles it.
     */
    'reply-done': (d: { mode: 'announce'; silent: boolean } | { mode: 'inband'; pcm: Buffer }) => void;
};

/**
 * The reply-audio output path of a voice device, extracted from
 * voice-assistant-device.mts (Org 1): segmenter -> FLAC encode -> LAN URL ->
 * play/queue, plus the in-band (TTS_END) accumulation path. Owns the three
 * mechanisms the old inline code spread across five fields:
 *
 *   - FIFO chain: encode/serve is async and the segmenter can emit several
 *     chunks back-to-back; chaining keeps segments in emit order (H-l).
 *   - Generation counter: abort() bumps it, so segment work queued (or already
 *     encoding) for an aborted turn is dropped instead of playing late.
 *   - Announce queue: one segment plays at a time; announceFinished() advances.
 *
 * File TTLs (M2/M9): announce segments carry playbackMs for the device to
 * extend the deletion TTL at play time; buildReplyFile() schedules the in-band
 * reply file's deletion itself.
 *
 * No ESP/protocol knowledge — the device listens to 'segment'/'reply-done' and
 * does the protocol sequencing.
 */
export class AudioOutputPipeline extends (EventEmitter as new () => TypedEmitter<PipelineEvents>) {
    // The device tests reach in to drive this directly; keep the name stable.
    readonly segmenter = new PcmSegmenter();

    private mode: ReplyMode = 'announce';
    // Whether the segmenter produced anything at all since the turn began.
    // Distinguishes "the reply is still being encoded" from "there is no reply
    // audio and never will be" — the queue/playing pair cannot: at flush time
    // an announce segment may still be in the async encode chain with the queue
    // empty and nothing playing yet. Keyed on emitted segments rather than fed
    // PCM because a segment is exactly what becomes an announcement.
    private sawSegment = false;
    private inbandPcm: Buffer[] = [];
    private queue: FileInfo[] = [];
    private playing = false;
    private chain: Promise<void> = Promise.resolve();
    private generation = 0;

    constructor(
        private homey: any,
        private webServer: { buildStream(audioData: AudioData): Promise<FileInfo> },
        private logger: { error: (...args: any[]) => void },
    ) {
        super();
        this.segmenter.on('chunk', (chunk: Buffer) => this.onSegmentPcm(chunk));
        this.segmenter.on('done', () => this.onReplyDone());
    }

    /** True while an announcement is playing on the device (old isPlaying). */
    get isPlaying(): boolean {
        return this.playing;
    }

    /** Announce segments waiting behind the current one (old announceUrls). */
    get queueLength(): number {
        return this.queue.length;
    }

    /** Start a turn: pick the reply route and drop any stale in-band PCM. */
    beginTurn(mode: ReplyMode): void {
        this.mode = mode;
        this.sawSegment = false;
        this.inbandPcm = [];
    }

    /** Reply PCM from the provider (audio.delta). */
    feed(pcm: Buffer): void {
        this.segmenter.feed(pcm);
    }

    /** The model's response is complete — flush the segmenter's tail. */
    flush(): void {
        this.segmenter.flush();
    }

    /**
     * Stop routing this turn in-band and drop what accumulated. Used when an
     * empty turn ends the run early, so a stray segmenter 'done' can't deliver
     * a duplicate in-band reply on top of the run_end already sent.
     */
    cancelInband(): void {
        this.mode = 'announce';
        this.inbandPcm = [];
    }

    /**
     * The device reported an announcement finished. 'ignore' when no announce
     * queue is active (late acks from reopen/continue announces must not end a
     * run); 'play' hands back the next queued segment; 'done' means the queue
     * drained — the turn's playback is over.
     */
    announceFinished(): { kind: 'ignore' } | { kind: 'play'; fileInfo: FileInfo } | { kind: 'done' } {
        if (!this.playing) {
            return { kind: 'ignore' };
        }
        const next = this.queue.shift();
        if (!next) {
            this.playing = false;
            return { kind: 'done' };
        }
        return { kind: 'play', fileInfo: next };
    }

    /**
     * Encode + serve the in-band reply and schedule the file's deletion, TTL
     * extended by the reply's playback length (M2/M9).
     *
     * `sampleRate` re-samples before encoding. The satellites play our native
     * 24 kHz happily, but third-party players often do not: Sonos documents FLAC
     * "up to 48 kHz" and is only actually tested at 44.1/48, so the Flow-URL path
     * asks for 48 kHz (an exact 2x upsample — no resampling quality question).
     *
     * `extraGraceMs` widens the deletion window beyond playback length. Our own
     * playback starts within milliseconds; a Flow handing the URL to a speaker may
     * group players, save a queue or ramp volume first, and 30 s of grace is thin
     * for that.
     *
     * `format` picks the container. Our satellites take FLAC (lossless, and the
     * only thing their firmware plays), but the Flow-URL path asks for `mp3`:
     * it hands the link to third-party players, and MP3 is the one format every
     * networked speaker plays without argument — FLAC support out there is
     * patchy and rate-fussy.
     */
    async buildReplyFile(
        pcm: Buffer,
        opts: { sampleRate?: number; extraGraceMs?: number; format?: ReplyFormat } = {},
    ): Promise<{ url: string; playbackMs: number }> {
        const { sampleRate = REPLY_SAMPLE_RATE, extraGraceMs = 0, format = 'flac' } = opts;
        // PCM16 mono 24 kHz = 48 bytes/ms. Measured before any resample, so the
        // duration is the same number either way.
        const playbackMs = Math.round(pcm.length / 48);
        const samples = sampleRate === REPLY_SAMPLE_RATE
            ? pcm
            : resamplePcm16Mono(pcm, REPLY_SAMPLE_RATE, sampleRate);
        const data = format === 'mp3'
            ? await pcmToMp3Buffer(samples, { sampleRate, channels: 1, bitsPerSample: 16 })
            : await pcmToFlacBuffer(samples, { sampleRate, channels: 1, bitsPerSample: 16 });
        const fileInfo = await this.webServer.buildStream({ data, extension: format, prefix: 'tx' });
        scheduleAudioFileDeletion(this.homey, fileInfo, playbackMs + extraGraceMs);
        return { url: fileInfo.url, playbackMs };
    }

    /**
     * Abort the turn's output: invalidate queued AND in-flight segment work
     * (generation bump), clear the queue and in-band buffer, reset the
     * segmenter without emitting. Reports whether playback was actually active.
     */
    abort(): { wasActive: boolean } {
        const wasActive = this.playing || this.queue.length > 0;
        this.playing = false;
        this.queue = [];
        this.sawSegment = false;
        this.inbandPcm = [];
        this.mode = 'announce';
        this.generation++;
        this.chain = Promise.resolve();
        this.segmenter.reset();
        return { wasActive };
    }

    private onSegmentPcm(chunk: Buffer): void {
        this.sawSegment = true;

        // In-band: accumulate synchronously (the 'done' handler reads it) —
        // never through the async chain.
        if (this.mode === 'inband') {
            this.inbandPcm.push(chunk);
            return;
        }

        // Announce path: serialize the async encode/serve so segments emit in
        // order (H-l). The generation is checked both before starting and after
        // the awaits, so a segment from an aborted turn can't play late.
        const gen = this.generation;
        this.chain = this.chain
            .then(async () => {
                if (gen !== this.generation) return;
                const fileInfo = await this.buildSegmentFile(chunk);
                if (gen !== this.generation) return;

                if (this.playing) {
                    this.queue.push(fileInfo);
                    this.emit('segment', { fileInfo, action: 'queued' });
                } else {
                    this.playing = true;
                    this.emit('segment', { fileInfo, action: 'play' });
                }
            })
            .catch(err => this.logger.error('Failed to prepare reply segment', err));
    }

    private async buildSegmentFile(chunk: Buffer): Promise<FileInfo> {
        const flac = await pcmToFlacBuffer(chunk, {
            sampleRate: 24_000,
            channels: 1,
            bitsPerSample: 16,
        });
        const fileInfo = await this.webServer.buildStream({ data: flac, extension: 'flac', prefix: 'tx' });
        // PCM16 mono 24 kHz = 48 bytes/ms; lets the play path extend the file's
        // deletion TTL to cover the whole clip (M9).
        fileInfo.playbackMs = Math.round(chunk.length / 48);
        return fileInfo;
    }

    private onReplyDone(): void {
        if (this.mode === 'inband') {
            // Consumed: a later stray 'done' must not deliver a duplicate reply.
            this.mode = 'announce';
            const pcm = this.inbandPcm.length > 0 ? Buffer.concat(this.inbandPcm) : Buffer.alloc(0);
            this.inbandPcm = [];
            this.emit('reply-done', { mode: 'inband', pcm });
        } else {
            this.emit('reply-done', { mode: 'announce', silent: !this.sawSegment });
        }
    }
}
