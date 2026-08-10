import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { RecordingRegistry, MAX_RECORDINGS, retentionMsFromSetting } from '../src/helpers/recording-registry.mjs';
import { FileInfo } from '../src/helpers/interfaces.mjs';

/**
 * The "what did I just say?" store: recordings survive their turn for the
 * retention window, carry the transcript STT produced, and play back on the
 * satellite that recorded them.
 */

/** Records scheduled deletions instead of running them, so tests stay fast. */
function makeHomey() {
    const timers: { cb: Function; ms: number }[] = [];
    return {
        timers,
        setTimeout: (cb: Function, ms: number) => { timers.push({ cb, ms }); return timers.length; },
        clearTimeout: (_t: any) => { },
        /** Fire the deletion that was scheduled for a given index. */
        fire: (index: number) => timers[index].cb(),
    };
}

describe('RecordingRegistry', () => {
    let dir: string;
    let registry: RecordingRegistry;
    let homey: ReturnType<typeof makeHomey>;
    let counter = 0;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'rec-registry-'));
        registry = new RecordingRegistry();
        homey = makeHomey();
        registry.init(homey as any);
        counter = 0;
    });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    async function addRecording(overrides: { deviceId?: string; durationMs?: number; retentionMs?: number } = {}) {
        const filename = `rx_${counter++}.flac`;
        const filepath = join(dir, filename);
        await fs.writeFile(filepath, 'flac');
        const file: FileInfo = { filename, filepath, url: `http://192.168.1.2/${filename}` };
        return registry.add({
            file,
            deviceId: overrides.deviceId ?? 'device-a',
            deviceName: 'Kitchen',
            durationMs: overrides.durationMs ?? 2_500,
            retentionMs: overrides.retentionMs ?? 900_000,
        });
    }

    it('keeps a recording with its duration and schedules deletion at the retention window', async () => {
        const recording = await addRecording({ retentionMs: 900_000 });

        expect(registry.list()).toHaveLength(1);
        expect(recording.durationMs).toBe(2_500);
        expect(recording.transcript).toBe('');
        // ~15 minutes, not the 30 s TTL every other audio file gets.
        expect(homey.timers[0].ms).toBeGreaterThan(890_000);
    });

    it('labels a recording with what speech-to-text heard', async () => {
        const recording = await addRecording();
        registry.setTranscript(recording.id, 'turn off the kitchen light');

        expect(registry.list()[0].transcript).toBe('turn off the kitchen light');
    });

    it('lists newest first and can narrow to one satellite', async () => {
        const first = await addRecording({ deviceId: 'device-a' });
        const second = await addRecording({ deviceId: 'device-b' });

        expect(registry.list().map((r) => r.id)).toEqual([second.id, first.id]);
        expect(registry.list('device-a').map((r) => r.id)).toEqual([first.id]);
    });

    it('deletes the file when the retention window is up', async () => {
        const recording = await addRecording();
        await homey.fire(0);

        expect(registry.list()).toHaveLength(0);
        await expect(fs.access(recording.filepath)).rejects.toThrow();
    });

    it(`keeps at most ${MAX_RECORDINGS} recordings and deletes the dropped files`, async () => {
        const first = await addRecording();
        for (let i = 0; i < MAX_RECORDINGS; i++) await addRecording();

        expect(registry.list()).toHaveLength(MAX_RECORDINGS);
        expect(registry.get(first.id)).toBeUndefined();
        // The entry is dropped synchronously; its file is unlinked right after.
        await expect.poll(() => fs.access(first.filepath).then(() => true, () => false)).toBe(false);
    });

    it('plays recordings on the satellite that recorded them', async () => {
        const played: string[] = [];
        registry.registerPlayer('device-a', async (recordings) => {
            for (const r of recordings) played.push(r.id);
        });
        const first = await addRecording({ deviceId: 'device-a' });
        const second = await addRecording({ deviceId: 'device-a' });

        const result = await registry.play([first, second]);

        expect(result.played).toBe(2);
        expect(played).toEqual([first.id, second.id]);
    });

    it('reports when the recording device has no player (e.g. it was removed)', async () => {
        const recording = await addRecording({ deviceId: 'gone' });
        const result = await registry.play([recording]);

        expect(result.played).toBe(0);
        expect(result.message).toMatch(/No connected satellite/);
    });

    it('stops offering a device once it unregisters', async () => {
        const unregister = registry.registerPlayer('device-a', async () => { });
        unregister();
        const recording = await addRecording({ deviceId: 'device-a' });

        expect((await registry.play([recording])).played).toBe(0);
    });
});

describe('retentionMsFromSetting', () => {
    it('defaults to 15 minutes when unset', () => {
        expect(retentionMsFromSetting(undefined)).toBe(15 * 60_000);
    });

    it('uses the configured number of minutes', () => {
        expect(retentionMsFromSetting(5)).toBe(5 * 60_000);
        expect(retentionMsFromSetting('30')).toBe(30 * 60_000);
    });

    it('caps at an hour and rejects nonsense', () => {
        expect(retentionMsFromSetting(600)).toBe(60 * 60_000);
        expect(retentionMsFromSetting(-1)).toBe(15 * 60_000);
        expect(retentionMsFromSetting('abc')).toBe(15 * 60_000);
    });
});
