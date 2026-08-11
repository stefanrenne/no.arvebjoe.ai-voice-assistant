import { describe, it, expect } from 'vitest';
import { pcmToFlacBuffer, pcmToMp3Buffer } from '../src/helpers/audio-encoders.mjs';

function sinePcm(samples: number, amplitude = 8000): Buffer {
    const buf = Buffer.allocUnsafe(samples * 2);
    for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(amplitude * Math.sin(i / 8)), i * 2);
    return buf;
}

describe('pcmToFlacBuffer', () => {
    it('encodes 16-bit mono PCM to a FLAC stream (fLaC magic)', async () => {
        const pcm = sinePcm(4800); // 300 ms @ 16k
        const flac = await pcmToFlacBuffer(pcm, { sampleRate: 16000, channels: 1, bitsPerSample: 16 });
        expect(flac.length).toBeGreaterThan(0);
        expect(flac.toString('ascii', 0, 4)).toBe('fLaC');
    });

    it('rejects PCM whose length is not a whole number of sample-frames', async () => {
        // 16-bit mono => frame is 2 bytes; an odd length is invalid.
        await expect(pcmToFlacBuffer(Buffer.alloc(101), { bitsPerSample: 16, channels: 1 }))
            .rejects.toThrow(/multiple of/i);
    });

    it('rejects an unsupported bit depth', async () => {
        // 24-bit: frame is 3 bytes, so use a length that IS a multiple of 3 to
        // reach the bit-depth branch rather than the frame-size guard.
        await expect(pcmToFlacBuffer(Buffer.alloc(99), { bitsPerSample: 24, channels: 1 }))
            .rejects.toThrow(/Unsupported bits per sample/i);
    });
});

describe('pcmToMp3Buffer', () => {
    it('encodes 16-bit mono PCM to an MP3 stream (frame sync)', async () => {
        // 48 kHz mono is exactly what the Flow-URL reply path asks for.
        const pcm = sinePcm(48_000);
        const mp3 = await pcmToMp3Buffer(pcm, { sampleRate: 48_000, channels: 1, bitsPerSample: 16 });
        expect(mp3.length).toBeGreaterThan(0);
        // First frame header: 11 sync bits, then MPEG-1 (0b11) Layer III (0b01).
        expect(mp3[0]).toBe(0xff);
        expect(mp3[1] & 0xfe).toBe(0xfa);
    });

    it('encodes a tail shorter than one MPEG granule', async () => {
        // Anything under 1152 samples only leaves the encoder on flush(); an
        // encodeBuffer-only implementation would return an empty file here.
        const mp3 = await pcmToMp3Buffer(sinePcm(400), { sampleRate: 48_000 });
        expect(mp3.length).toBeGreaterThan(0);
    });

    it('rejects PCM whose length is not a whole number of sample-frames', async () => {
        await expect(pcmToMp3Buffer(Buffer.alloc(101), { bitsPerSample: 16, channels: 1 }))
            .rejects.toThrow(/multiple of/i);
    });

    it('rejects an unsupported bit depth', async () => {
        await expect(pcmToMp3Buffer(Buffer.alloc(99), { bitsPerSample: 24, channels: 1 }))
            .rejects.toThrow(/Unsupported bits per sample/i);
    });
});
