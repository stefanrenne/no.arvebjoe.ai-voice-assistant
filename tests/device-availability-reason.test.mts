import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks (hoisted) must be registered before the harness imports the device. ---
vi.mock('homey', () => import('./mocks/mock-homey-sdk.mjs'));
vi.mock('../src/voice_assistant/esp-voice-assistant-client.mjs', () => import('./mocks/mock-esp-client.mjs'));
vi.mock('../src/llm/voice-provider-factory.mjs', () => import('./mocks/mock-voice-provider.mjs'));
vi.mock('../src/helpers/audio-encoders.mjs', () => ({
    pcmToFlacBuffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
    pcmToMp3Buffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
}));
vi.mock('../src/helpers/listening-chime.mjs', async (importOriginal) => ({
    ...(await importOriginal() as object),
    ensureListeningChime: async () => 'listening_chime.flac',
    ensureMicClosedChime: async () => 'mic_closed_chime.flac',
}));
vi.mock('../src/helpers/feedback-sounds.mjs', () => ({
    ensureFeedbackSoundMp3: async (key: string) => ({ filename: `feedback_${key}.mp3`, durationMs: 4000 }),
}));

import { createHarness, Harness } from './mocks/device-harness.mjs';
import { __resetProviderRegistry } from './mocks/mock-voice-provider.mjs';
import { seenDevices } from '../src/helpers/seen-devices.mjs';

/**
 * "Unavailable" covers TWO independent links — the satellite and the voice
 * engine — and saying only that is what sent a field reporter after his network
 * (SSH session, port check, a whole Home Assistant install) when a missing API
 * key was the likely cause. These cases pin that the tile names which side is
 * down, and that the Debug page carries the two links separately.
 */

/** Bring both links up, the way a healthy boot does. */
function bothUp(h: Harness) {
    h.esp.emit('Healthy');
    h.provider.emit('Healthy');
}

describe('unavailable reason names the failing side', () => {
    beforeEach(() => {
        __resetProviderRegistry();
    });

    it('is available, with no reason, when both links are up', async () => {
        const h = await createHarness();
        bothUp(h);

        expect(h.device.getAvailable()).toBe(true);
        expect((h.device as any).unavailableMessage).toBeNull();
    });

    it('blames the engine — by name — when only the satellite is up', async () => {
        const h = await createHarness();
        bothUp(h);
        h.provider.emit('Unhealthy');

        expect(h.device.getAvailable()).toBe(false);
        const msg = (h.device as any).unavailableMessage as string;
        expect(msg).toMatch(/OpenAI Realtime/);
        expect(msg).toMatch(/API key/i);
        // Must not send the user to the network — that is the whole point.
        expect(msg).not.toMatch(/same network/i);
    });

    it('names the selected engine, not a hardcoded one', async () => {
        const h = await createHarness({ globals: { voice_provider: 'gemini-realtime' } });
        bothUp(h);
        h.provider.emit('Unhealthy');

        expect((h.device as any).unavailableMessage).toMatch(/Google Gemini Live/);
    });

    it('blames the device, and points at the network, when only the engine is up', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('Unhealthy');

        const msg = (h.device as any).unavailableMessage as string;
        expect(msg).toMatch(/No connection to the device/);
        expect(msg).toMatch(/same network/i);
        expect(msg).not.toMatch(/API key/i);
    });

    it('says so when both links are down', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('Unhealthy');
        h.provider.emit('Unhealthy');

        const msg = (h.device as any).unavailableMessage as string;
        expect(msg).toMatch(/No connection to the device/);
        expect(msg).toMatch(/not connected either/);
    });

    // The old updateAvailable() only called setUnavailable() on a true -> false
    // edge, so a reason that changed while the device stayed unavailable never
    // reached the tile — it would still blame the satellite after the satellite
    // came back.
    it('updates the reason while the device stays unavailable', async () => {
        const h = await createHarness();
        bothUp(h);

        h.esp.emit('Unhealthy');
        h.provider.emit('Unhealthy');
        expect((h.device as any).unavailableMessage).toMatch(/not connected either/);

        // Satellite returns; the engine is still down. Never became available.
        h.esp.emit('Healthy');
        expect(h.device.getAvailable()).toBe(false);
        const msg = (h.device as any).unavailableMessage as string;
        expect(msg).toMatch(/The device is connected/);
        expect(msg).toMatch(/OpenAI Realtime/);
    });

    it('does not repeat an unchanged reason', async () => {
        const h = await createHarness();
        bothUp(h);
        h.provider.emit('Unhealthy');

        const before = (h.device as any).unavailableMessages.length;
        h.provider.emit('Unhealthy');   // same fault again
        expect((h.device as any).unavailableMessages.length).toBe(before);
    });

    it('clears the reason when both links recover', async () => {
        const h = await createHarness();
        bothUp(h);
        h.provider.emit('Unhealthy');
        expect(h.device.getAvailable()).toBe(false);

        h.provider.emit('Healthy');
        expect(h.device.getAvailable()).toBe(true);
        expect((h.device as any).unavailableMessage).toBeNull();
    });
});

describe('the Debug list carries the two links separately', () => {
    beforeEach(() => {
        __resetProviderRegistry();
    });

    it('reports device up / engine down as two distinct flags', async () => {
        const h = await createHarness();
        bothUp(h);
        h.provider.emit('Unhealthy');

        const entry = seenDevices.get(String(h.device.getData().id));
        expect(entry).toBeDefined();
        expect(entry!.available).toBe(false);
        expect(entry!.deviceConnected).toBe(true);
        expect(entry!.engineConnected).toBe(false);
        expect(entry!.engineName).toBe('OpenAI Realtime');
    });

    it('reports device down / engine up the other way round', async () => {
        const h = await createHarness();
        bothUp(h);
        h.esp.emit('Unhealthy');

        const entry = seenDevices.get(String(h.device.getData().id));
        expect(entry!.deviceConnected).toBe(false);
        expect(entry!.engineConnected).toBe(true);
    });

    it('marks both connected when the device is available', async () => {
        const h = await createHarness();
        bothUp(h);

        const entry = seenDevices.get(String(h.device.getData().id));
        expect(entry!.available).toBe(true);
        expect(entry!.deviceConnected).toBe(true);
        expect(entry!.engineConnected).toBe(true);
    });
});
