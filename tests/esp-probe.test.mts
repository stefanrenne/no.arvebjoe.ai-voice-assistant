import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { probeEspDevice } from '../src/voice_assistant/esp-probe.mjs';

/**
 * The shared capability probe behind BOTH the pair flow and the Debug page's
 * "last seen devices" list — so these cases pin the mapping the driver relies
 * on (accessible / not_a_match / requires_encryption / encryption_error /
 * unreachable / timeout).
 */

const homey = {
    setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
    clearTimeout: (t: any) => clearTimeout(t),
};

/** A stand-in for EspVoiceAssistantClient: an emitter with the same surface. */
class FakeClient extends EventEmitter {
    disconnected = false;
    started = false;
    constructor(private identity: { mac?: string; friendlyName?: string } = {}) { super(); }
    async start(): Promise<void> { this.started = true; }
    async disconnect(): Promise<boolean> { this.disconnected = true; return true; }
    getMacAddress(): string { return this.identity.mac ?? ''; }
    getFriendlyName(): string { return this.identity.friendlyName ?? ''; }
}

function probeWith(client: FakeClient, emit: (c: FakeClient) => void, timeoutMs = 200) {
    const promise = probeEspDevice(homey as any, {
        host: '192.168.1.50',
        port: 6053,
        timeoutMs,
        createClient: () => client,
    });
    // Let probeEspDevice attach its listeners before the device "answers".
    setImmediate(() => emit(client));
    return promise;
}

describe('probeEspDevice', () => {
    it('reports a voice satellite as accessible, with its identity', async () => {
        const client = new FakeClient({ mac: 'AA:BB:CC:DD:EE:FF', friendlyName: 'Kitchen Voice' });
        const result = await probeWith(client, (c) => c.emit('capabilities', 1, 1, 1, 'pe'));

        expect(result.status).toBe('accessible');
        expect(result.deviceType).toBe('pe');
        expect(result.mac).toBe('AA:BB:CC:DD:EE:FF');
        expect(result.friendlyName).toBe('Kitchen Voice');
        expect(client.disconnected).toBe(true);
    });

    it('reports a device without voice capabilities as not_a_match', async () => {
        const client = new FakeClient();
        const result = await probeWith(client, (c) => c.emit('capabilities', 0, 0, 0, null));

        expect(result.status).toBe('not_a_match');
        expect(result.deviceType).toBeNull();
    });

    it('reports the plaintext refusal of an encrypted device', async () => {
        const client = new FakeClient();
        const result = await probeWith(client, (c) => c.emit('requires_encryption'));

        expect(result.status).toBe('requires_encryption');
    });

    it('passes the precise Noise failure code through', async () => {
        const client = new FakeClient();
        const result = await probeWith(client, (c) => c.emit('encryption_error', 'wrong_key', 'PSK rejected'));

        expect(result.status).toBe('encryption_error');
        expect(result.code).toBe('wrong_key');
        expect(result.message).toBe('PSK rejected');
    });

    it('reports a dropped connection as unreachable', async () => {
        const client = new FakeClient();
        const result = await probeWith(client, (c) => c.emit('Unhealthy'));

        expect(result.status).toBe('unreachable');
    });

    it('times out when nothing answers, and still tears the client down', async () => {
        const client = new FakeClient();
        const result = await probeEspDevice(homey as any, {
            host: '192.168.1.51',
            timeoutMs: 30,
            createClient: () => client,
        });

        expect(result.status).toBe('timeout');
        expect(client.disconnected).toBe(true);
    });

    it('keeps the first outcome when a teardown event follows', async () => {
        const client = new FakeClient();
        const result = await probeWith(client, (c) => {
            c.emit('capabilities', 1, 1, 1, 'tr');
            c.emit('Unhealthy');
        });

        expect(result.status).toBe('accessible');
        expect(result.deviceType).toBe('tr');
    });

    it('treats a failing start() as unreachable', async () => {
        const client = new FakeClient();
        client.start = async () => { throw new Error('ECONNREFUSED'); };
        const result = await probeEspDevice(homey as any, {
            host: '192.168.1.52',
            timeoutMs: 500,
            createClient: () => client,
        });

        expect(result.status).toBe('unreachable');
    });
});
