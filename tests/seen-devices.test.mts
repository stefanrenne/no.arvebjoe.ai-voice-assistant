import { describe, it, expect, beforeEach } from 'vitest';
import { SeenDevicesRegistry, MAX_SEEN_DEVICES } from '../src/helpers/seen-devices.mjs';
import { EspProbeResult } from '../src/voice_assistant/esp-probe.mjs';

/** Registry behind the Debug page's "Last seen devices" list. */

function mdnsResult(overrides: Record<string, any> = {}) {
    return {
        id: 'aabbccddeeff',
        name: 'home-assistant-voice-09a1b2',
        host: 'home-assistant-voice-09a1b2.local',
        address: '192.168.1.50',
        port: 6053,
        txt: {
            mac: 'aabbccddeeff',
            platform: 'ESP32-S3',
            version: '2026.1.0',
            friendly_name: 'Kitchen Voice',
            project_name: 'nabucasa.home-assistant-voice',
            project_version: '26.1.0',
            board: 'esp32s3box',
            network: 'wifi',
        },
        ...overrides,
    };
}

function probeResult(overrides: Partial<EspProbeResult> = {}): EspProbeResult {
    return {
        status: 'accessible',
        deviceType: 'pe',
        mediaPlayers: 1,
        subscribeVoiceAssistant: 1,
        voiceAssistantConfiguration: 1,
        mac: '',
        friendlyName: '',
        code: '',
        message: '',
        ...overrides,
    };
}

describe('SeenDevicesRegistry', () => {
    let registry: SeenDevicesRegistry;
    beforeEach(() => { registry = new SeenDevicesRegistry(); });

    it('records every mDNS field the pair flow matches on', () => {
        registry.recordDiscovery(mdnsResult());
        const [device] = registry.list();

        expect(device.id).toBe('aabbccddeeff');
        expect(device.name).toBe('home-assistant-voice-09a1b2');
        expect(device.friendlyName).toBe('Kitchen Voice');
        // The label the pair dialog would show (friendly_name || name || host).
        expect(device.pairName).toBe('Kitchen Voice');
        expect(device.platform).toBe('ESP32-S3');
        expect(device.version).toBe('2026.1.0');
        expect(device.project).toBe('nabucasa.home-assistant-voice 26.1.0');
        expect(device.address).toBe('192.168.1.50');
        expect(device.port).toBe(6053);
        expect(device.encrypted).toBe(false);
        expect(device.accessible).toBe(false); // not probed yet
    });

    it('falls back to the service name, then the host, for the pair label', () => {
        registry.recordDiscovery(mdnsResult({ txt: { mac: 'x' } }));
        expect(registry.list()[0].pairName).toBe('home-assistant-voice-09a1b2');

        registry.recordDiscovery(mdnsResult({ id: 'other', name: '', txt: {} }));
        expect(registry.get('other')!.pairName).toBe('home-assistant-voice-09a1b2.local');
    });

    it('flags api_encryption devices', () => {
        registry.recordDiscovery(mdnsResult({ txt: { mac: 'aabb', api_encryption: 'Noise_NNpsk0_25519_ChaChaPoly_SHA256' } }));
        expect(registry.list()[0].encrypted).toBe(true);
    });

    it('counts repeat sightings and keeps the first-seen time', () => {
        registry.recordDiscovery(mdnsResult(), 1_000);
        registry.recordDiscovery(mdnsResult(), 5_000);
        const [device] = registry.list();

        expect(device.seenCount).toBe(2);
        expect(device.firstSeen).toBe(1_000);
        expect(device.lastSeen).toBe(5_000);
    });

    it('stars a device whose probe found a voice satellite', () => {
        registry.recordDiscovery(mdnsResult());
        registry.recordProbe('aabbccddeeff', probeResult(), 'background');
        const [device] = registry.list();

        expect(device.accessible).toBe(true);
        expect(device.probe!.deviceType).toBe('pe');
        expect(device.probe!.by).toBe('background');
    });

    it('does not star a device that answered but is not a satellite', () => {
        registry.recordDiscovery(mdnsResult());
        registry.recordProbe('aabbccddeeff', probeResult({ status: 'not_a_match', deviceType: null }), 'pairing');
        expect(registry.list()[0].accessible).toBe(false);
    });

    it('stars a paired device that is currently connected, without a probe', () => {
        registry.recordDiscovery(mdnsResult());
        registry.markPaired('aabbccddeeff', { name: 'Kitchen', available: true });
        const [device] = registry.list();

        expect(device.paired).toBe(true);
        expect(device.pairedName).toBe('Kitchen');
        expect(device.accessible).toBe(true);
    });

    it('drops the probe result when the device moves to another address', () => {
        registry.recordDiscovery(mdnsResult());
        registry.recordProbe('aabbccddeeff', probeResult(), 'background');
        registry.recordDiscovery(mdnsResult({ address: '192.168.1.77' }));

        expect(registry.list()[0].probe).toBeNull();
        expect(registry.unprobed().map((d) => d.id)).toEqual(['aabbccddeeff']);
    });

    it('records a probe for a device mDNS never delivered (manual entry)', () => {
        registry.recordProbe('11:22:33', probeResult({ mac: '11:22:33', friendlyName: 'Hall' }), 'pairing');
        const [device] = registry.list();

        expect(device.mac).toBe('11:22:33');
        expect(device.friendlyName).toBe('Hall');
        expect(device.accessible).toBe(true);
    });

    it('lists newest sighting first', () => {
        registry.recordDiscovery(mdnsResult({ id: 'old' }), 1_000);
        registry.recordDiscovery(mdnsResult({ id: 'new' }), 9_000);
        expect(registry.list().map((d) => d.id)).toEqual(['new', 'old']);
    });

    it(`keeps at most ${MAX_SEEN_DEVICES} devices, evicting the oldest un-paired ones`, () => {
        for (let i = 0; i < MAX_SEEN_DEVICES + 5; i++) {
            registry.recordDiscovery(mdnsResult({ id: `dev-${i}` }), 1_000 + i);
        }
        expect(registry.size()).toBe(MAX_SEEN_DEVICES);
        expect(registry.get('dev-0')).toBeUndefined();
        expect(registry.get(`dev-${MAX_SEEN_DEVICES + 4}`)).toBeDefined();
    });

    it('never evicts a paired device', () => {
        registry.recordDiscovery(mdnsResult({ id: 'mine' }), 1);
        registry.markPaired('mine', { name: 'Mine', available: false });
        for (let i = 0; i < MAX_SEEN_DEVICES + 5; i++) {
            registry.recordDiscovery(mdnsResult({ id: `dev-${i}` }), 1_000 + i);
        }
        expect(registry.get('mine')).toBeDefined();
    });

    it('clears the paired flag when the device is deleted', () => {
        registry.recordDiscovery(mdnsResult());
        registry.markPaired('aabbccddeeff', { available: true });
        registry.markUnpaired('aabbccddeeff');
        const [device] = registry.list();

        expect(device.paired).toBe(false);
        expect(device.accessible).toBe(false);
    });

    it('offers only un-paired, never-probed devices for a background probe', () => {
        registry.recordDiscovery(mdnsResult({ id: 'fresh' }));
        registry.recordDiscovery(mdnsResult({ id: 'probed' }));
        registry.recordProbe('probed', probeResult(), 'background');
        registry.recordDiscovery(mdnsResult({ id: 'mine' }));
        registry.markPaired('mine', { available: true });

        expect(registry.unprobed().map((d) => d.id)).toEqual(['fresh']);
    });
});
