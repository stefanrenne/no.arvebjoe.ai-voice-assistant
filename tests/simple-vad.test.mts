import { describe, it, expect } from 'vitest';
import { SimpleVad } from '../src/llm/providers/local/simple-vad.mjs';

const RATE = 16000;

function silence(ms: number): Buffer {
    return Buffer.alloc(Math.round(RATE * ms / 1000) * 2);
}

function speech(ms: number, amplitude = 8000): Buffer {
    const samples = Math.round(RATE * ms / 1000);
    const buf = Buffer.alloc(samples * 2);
    for (let i = 0; i < samples; i++) {
        buf.writeInt16LE(Math.round(amplitude * Math.sin(2 * Math.PI * 300 * i / RATE)), i * 2);
    }
    return buf;
}

/** Feed a buffer in device-sized chunks (~32 ms), merging the results. */
function feedAll(vad: SimpleVad, pcm: Buffer) {
    const out = { speechStart: false, utterance: null as Buffer | null, timeout: false, reason: undefined as string | undefined };
    const chunk = 1024;
    for (let off = 0; off < pcm.length; off += chunk) {
        const r = vad.feed(pcm.subarray(off, Math.min(off + chunk, pcm.length)));
        out.speechStart = out.speechStart || r.speechStart;
        if (r.utterance && !out.utterance) { out.utterance = r.utterance; out.reason = r.reason; }
        out.timeout = out.timeout || r.timeout;
    }
    return out;
}

describe('SimpleVad', () => {
    it('detects speech start and closes the utterance after trailing silence', () => {
        const vad = new SimpleVad({ silenceMs: 600, noSpeechTimeoutMs: 8000 });
        vad.reset();

        const lead = feedAll(vad, silence(300));
        expect(lead.speechStart).toBe(false);
        expect(lead.utterance).toBeNull();

        const talk = feedAll(vad, speech(700));
        expect(talk.speechStart).toBe(true);
        expect(talk.utterance).toBeNull(); // still talking

        const tail = feedAll(vad, silence(800));
        expect(tail.utterance).not.toBeNull();
        // Utterance covers pre-roll + speech + silence tail (roughly).
        const ms = (tail.utterance!.length / 2 / RATE) * 1000;
        expect(ms).toBeGreaterThan(700);
    });

    it('times out when the user never speaks', () => {
        const vad = new SimpleVad({ noSpeechTimeoutMs: 2000 });
        vad.reset();
        const r = feedAll(vad, silence(2500));
        expect(r.timeout).toBe(true);
        expect(r.utterance).toBeNull();
        expect(r.speechStart).toBe(false);
    });

    it('goes inert after the utterance until reset()', () => {
        const vad = new SimpleVad({ silenceMs: 400 });
        vad.reset();
        feedAll(vad, speech(500));
        const done = feedAll(vad, silence(600));
        expect(done.utterance).not.toBeNull();

        const after = feedAll(vad, speech(500));
        expect(after.speechStart).toBe(false);
        expect(after.utterance).toBeNull();

        vad.reset();
        const again = feedAll(vad, speech(500));
        expect(again.speechStart).toBe(true);
    });

    it('ignores a short click (below minSpeechMs) followed by quiet', () => {
        const vad = new SimpleVad({ minSpeechMs: 200, silenceMs: 400, noSpeechTimeoutMs: 60000 });
        vad.reset();
        feedAll(vad, silence(200));
        const click = feedAll(vad, speech(60)); // 60 ms pop
        expect(click.speechStart).toBe(true);   // best-effort signal fires...
        const quiet = feedAll(vad, silence(600));
        expect(quiet.utterance).toBeNull();     // ...but no utterance is produced

        // Real speech afterwards still works in the same turn.
        const talk = feedAll(vad, speech(600));
        const tail = feedAll(vad, silence(600));
        expect(talk.speechStart || tail.speechStart).toBe(true);
        expect(tail.utterance).not.toBeNull();
    });

    it('detects quiet but clear speech (RMS ~350) with the default floor', () => {
        // Live ThirdReality recordings put intelligible speech at RMS 120-540;
        // the old floor of 500 folded those turns away as clicks. Amplitude 500
        // on a sine is RMS ~354.
        const vad = new SimpleVad({ silenceMs: 400 });
        vad.reset();
        feedAll(vad, silence(200));
        const talk = feedAll(vad, speech(1000, 500));
        const tail = feedAll(vad, silence(600));
        expect(talk.speechStart).toBe(true);
        expect(tail.utterance).not.toBeNull();
        expect(tail.reason).toBe('silence');
        expect(vad.stats().peakRms).toBeGreaterThan(300);
    });

    it('hands over what it heard when the no-speech timer runs out after a false start', () => {
        // Speech that only occasionally pokes above the threshold never lasts
        // minSpeechMs, so it is folded back — but it DID cross, so the timeout
        // must return the audio (pre-roll + everything since) instead of
        // reporting silence. Force the situation with a high floor.
        const vad = new SimpleVad({ minSpeechRms: 3000, minSpeechMs: 200, silenceMs: 400, noSpeechTimeoutMs: 3000 });
        vad.reset();
        feedAll(vad, silence(200));
        const click = feedAll(vad, speech(100, 8000));    // above 3000 for 100 ms only
        expect(click.speechStart).toBe(true);
        const quiet = feedAll(vad, speech(2000, 1500));   // "speech" below the bar
        expect(quiet.utterance).toBeNull();
        const out = feedAll(vad, silence(1500));          // …until the 3 s timer runs out
        expect(out.timeout).toBe(false);
        expect(out.utterance).not.toBeNull();
        expect(out.reason).toBe('timeout');
        // Pre-roll (300 ms) + click + quiet speech + tail up to the timeout ≈ 3 s.
        const ms = out.utterance!.length / 2 / 16;
        expect(ms).toBeGreaterThan(2500);
        expect(ms).toBeLessThanOrEqual(3300);
        expect(vad.stats().speechFrames).toBeGreaterThan(0);
    });

    it('reports a plain timeout when nothing ever crossed the threshold', () => {
        const vad = new SimpleVad({ noSpeechTimeoutMs: 1000 });
        vad.reset();
        const out = feedAll(vad, silence(1200));
        expect(out.timeout).toBe(true);
        expect(out.utterance).toBeNull();
        expect(vad.stats().peakRms).toBe(0);
    });

    it('caps a never-ending utterance at maxUtteranceMs', () => {
        const vad = new SimpleVad({ maxUtteranceMs: 1000, silenceMs: 60000 });
        vad.reset();
        const r = feedAll(vad, speech(2000));
        expect(r.utterance).not.toBeNull();
        const ms = (r.utterance!.length / 2 / RATE) * 1000;
        expect(ms).toBeLessThan(1700);
    });
});
