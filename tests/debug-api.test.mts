import { describe, it, expect, beforeEach, vi } from 'vitest';

// The probe is the only external the debug routes touch; fake it so no socket
// is opened. Everything else (both registries) runs for real. The factory is
// hoisted above the imports, so the spy has to be created inside it.
vi.mock('../src/voice_assistant/esp-probe.mjs', () => ({
    probeEspDevice: vi.fn(async () => ({
        status: 'accessible' as const,
        deviceType: 'pe',
        mediaPlayers: 1, subscribeVoiceAssistant: 1, voiceAssistantConfiguration: 1,
        mac: '', friendlyName: '', code: '', message: '',
    })),
}));

import api from '../api.mjs';
import { probeEspDevice } from '../src/voice_assistant/esp-probe.mjs';
import { seenDevices } from '../src/helpers/seen-devices.mjs';
import { recordingRegistry } from '../src/helpers/recording-registry.mjs';

const probeSpy = probeEspDevice as unknown as ReturnType<typeof vi.fn>;

/** The four Debug-section routes the settings page calls. */
describe('debug web API', () => {
    const homey = {
        setTimeout: (_cb: () => void, _ms: number) => 1,
        clearTimeout: (_t: any) => { },
    };

    beforeEach(async () => {
        seenDevices.clear();
        await recordingRegistry.clear();
        recordingRegistry.init(homey as any);
        probeSpy.mockClear();
    });

    it('GET /seen-devices returns the recorded devices with the star computed', async () => {
        seenDevices.recordDiscovery({
            id: 'aabb', name: 'voice-1', address: '192.168.1.9', port: 6053,
            txt: { mac: 'aabb', platform: 'ESP32', friendly_name: 'Hall' },
        });

        const res = await (api as any).getSeenDevices();

        expect(res.devices).toHaveLength(1);
        expect(res.devices[0].pairName).toBe('Hall');
        expect(res.devices[0].accessible).toBe(false);
    });

    it('POST /probe-device re-probes a known device and stores the outcome', async () => {
        seenDevices.recordDiscovery({ id: 'aabb', address: '192.168.1.9', port: 6053, txt: { mac: 'aabb' } });

        const res = await (api as any).probeSeenDevice({ homey, body: { id: 'aabb' } });

        expect(probeSpy).toHaveBeenCalledOnce();
        expect(res.ok).toBe(true);
        expect(res.device.accessible).toBe(true);
        expect(seenDevices.get('aabb')!.probe!.by).toBe('manual');
    });

    it('POST /probe-device refuses an unknown device without touching the network', async () => {
        const res = await (api as any).probeSeenDevice({ homey, body: { id: 'nope' } });

        expect(res.ok).toBe(false);
        expect(probeSpy).not.toHaveBeenCalled();
    });

    it('GET /recordings lists what was captured, newest first', async () => {
        recordingRegistry.add({
            file: { filename: 'rx_1.flac', filepath: '/tmp/rx_1.flac', url: 'http://h/rx_1.flac' },
            deviceId: 'dev', deviceName: 'Kitchen', durationMs: 1_000, retentionMs: 60_000,
        });
        recordingRegistry.setTranscript('rx_1.flac', 'turn on the light');

        const res = await (api as any).getRecordings();

        expect(res.recordings).toHaveLength(1);
        expect(res.recordings[0].transcript).toBe('turn on the light');
    });

    it('POST /play-recording plays on the device that recorded it', async () => {
        const played: string[] = [];
        recordingRegistry.registerPlayer('dev', async (recs) => { played.push(...recs.map((r) => r.id)); });
        recordingRegistry.add({
            file: { filename: 'rx_2.flac', filepath: '/tmp/rx_2.flac', url: 'http://h/rx_2.flac' },
            deviceId: 'dev', deviceName: 'Kitchen', durationMs: 1_000, retentionMs: 60_000,
        });

        const res = await (api as any).playRecording({ body: { id: 'rx_2.flac' } });

        expect(res.ok).toBe(true);
        expect(played).toEqual(['rx_2.flac']);
    });

    it('POST /play-recording reports an expired/unknown recording', async () => {
        const res = await (api as any).playRecording({ body: { id: 'gone.flac' } });

        expect(res.ok).toBe(false);
        expect(res.message).toMatch(/gone/i);
    });
});
