import { describe, it, expect, beforeEach } from 'vitest';
import { DiscoveryWatcher } from '../src/helpers/discovery-watcher.mjs';
import { SeenDevicesRegistry } from '../src/helpers/seen-devices.mjs';
import { EspProbeResult } from '../src/voice_assistant/esp-probe.mjs';

/**
 * The always-on half of "Last seen devices": read Homey's discovery results
 * from the app (not only during pairing) and probe what we don't know yet.
 */

function makeHomey(results: any[]) {
    return {
        discovery: {
            getStrategy: (_id: string) => ({
                getDiscoveryResults: () => Object.fromEntries(results.map((r) => [r.id, r])),
            }),
        },
        setInterval: (_cb: Function, _ms: number) => 1,
        clearInterval: (_t: any) => { },
        setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
        clearTimeout: (t: any) => clearTimeout(t),
    };
}

function result(id: string, overrides: Record<string, any> = {}) {
    return {
        id,
        name: `esphome-${id}`,
        host: `esphome-${id}.local`,
        address: `192.168.1.${id.length}`,
        port: 6053,
        txt: { mac: id, platform: 'ESP32' },
        ...overrides,
    };
}

function fakeProbe(status: EspProbeResult['status'] = 'accessible') {
    const calls: string[] = [];
    const probe = async (_homey: any, options: any): Promise<EspProbeResult> => {
        calls.push(options.host);
        return {
            status,
            deviceType: status === 'accessible' ? 'pe' : null,
            mediaPlayers: 1, subscribeVoiceAssistant: 1, voiceAssistantConfiguration: 1,
            mac: '', friendlyName: '', code: '', message: '',
        };
    };
    return { probe, calls };
}

describe('DiscoveryWatcher', () => {
    let registry: SeenDevicesRegistry;
    beforeEach(() => { registry = new SeenDevicesRegistry(); });

    it('records every discovery result and probes the unknown ones', async () => {
        const { probe, calls } = fakeProbe();
        const watcher = new DiscoveryWatcher(makeHomey([result('aa'), result('bb')]) as any,
            { registry, probe: probe as any });

        await watcher.round();

        expect(registry.list().map((d) => d.id).sort()).toEqual(['aa', 'bb']);
        expect(calls).toHaveLength(2);
        expect(registry.list().every((d) => d.accessible)).toBe(true);
    });

    it('probes each device only once across rounds', async () => {
        const { probe, calls } = fakeProbe();
        const watcher = new DiscoveryWatcher(makeHomey([result('aa')]) as any, { registry, probe: probe as any });

        await watcher.round();
        await watcher.round();

        expect(calls).toEqual(['192.168.1.2']);
        expect(registry.list()[0].seenCount).toBe(2);
    });

    it('never probes an encrypted device (the handshake cannot succeed without the key)', async () => {
        const { probe, calls } = fakeProbe();
        const encrypted = result('cc', { txt: { mac: 'cc', platform: 'ESP32', api_encryption: 'Noise' } });
        const watcher = new DiscoveryWatcher(makeHomey([encrypted]) as any, { registry, probe: probe as any });

        await watcher.round();

        expect(calls).toHaveLength(0);
        expect(registry.list()[0].encrypted).toBe(true);
    });

    it('never probes a paired device (its live connection is the better signal)', async () => {
        const { probe, calls } = fakeProbe();
        registry.recordDiscovery(result('dd'));
        registry.markPaired('dd', { available: true });
        const watcher = new DiscoveryWatcher(makeHomey([result('dd')]) as any, { registry, probe: probe as any });

        await watcher.round();

        expect(calls).toHaveLength(0);
    });

    it('probes at most three devices per round', async () => {
        const { probe, calls } = fakeProbe();
        const results = ['a', 'bb', 'ccc', 'dddd', 'eeeee'].map((id) => result(id));
        const watcher = new DiscoveryWatcher(makeHomey(results) as any, { registry, probe: probe as any });

        await watcher.round();

        expect(calls).toHaveLength(3);
        expect(registry.list()).toHaveLength(5);
    });

    it('is a no-op when the platform has no discovery manager (emulator)', async () => {
        const { probe, calls } = fakeProbe();
        const homey = { setInterval: () => 1, clearInterval: () => { }, setTimeout, clearTimeout };
        const watcher = new DiscoveryWatcher(homey as any, { registry, probe: probe as any });

        await watcher.round();

        expect(registry.list()).toHaveLength(0);
        expect(calls).toHaveLength(0);
    });
});
