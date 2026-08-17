// A discovery probe must settle its capability verdict from DeviceInfoResponse
// alone and never send VoiceAssistantConfigurationRequest.
//
// Why this is pinned: on ESPHome 2025.8.0 - 2026.5.0 that request crashes an
// UNSUBSCRIBED device. VoiceAssistantConfigurationResponse.active_wake_words is
// a pointer that defaults to null, and the unsubscribed branch of
// send_voice_assistant_get_configuration_response_() sends the response without
// setting it, so calculate_size() dereferences nullptr and the ESP32 reboots.
// The satellite then goes silent and pairing times out. Subscribing instead
// would fix the crash but steal the voice pipeline from an already-paired
// device, so the probe relies on voice_assistant_feature_flags — sent
// unconditionally in DeviceInfoResponse, no subscription required.
import { describe, it, expect } from 'vitest';
import { EspVoiceAssistantClient } from '../src/voice_assistant/esp-voice-assistant-client.mjs';
import { encodeFrame } from '../src/voice_assistant/esp-messages.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

/** Builds a client and records every message name it tries to send. */
function makeProbe(discoveryMode: boolean) {
    const client = new EspVoiceAssistantClient(new MockHomey(), {
        host: '127.0.0.1',
        discoveryMode,
        logLevel: 0,
    });
    const sent: string[] = [];
    (client as any).send = (name: string) => { sent.push(name); };

    const capabilities: any[][] = [];
    client.on('capabilities', (...args: any[]) => { capabilities.push(args); });

    return { client, sent, capabilities };
}

/**
 * Drives the handshake up to and including DeviceInfoResponse, in the real
 * order: Hello, then the entity list, then device info. `hasMediaPlayer`
 * controls whether a media-player entity is announced, since the connection
 * resets the entity counters on Hello.
 */
async function handshake(
    client: EspVoiceAssistantClient,
    deviceInfo: Record<string, any>,
    hasMediaPlayer = true,
) {
    await (client as any).onTcpData(encodeFrame('HelloResponse', { apiVersionMajor: 1, apiVersionMinor: 14 }));
    if (hasMediaPlayer) {
        await (client as any).onTcpData(encodeFrame('ListEntitiesMediaPlayerResponse', {
            objectId: 'media_player',
            name: 'Media Player',
            key: 4242,
        }));
    }
    await (client as any).onTcpData(encodeFrame('DeviceInfoResponse', deviceInfo));
}

const VOICE_PE = {
    name: 'home-assistant-voice-09xyz',
    manufacturer: 'Nabu Casa',
    model: 'Home Assistant Voice PE',
    // FEATURE_VOICE_ASSISTANT | FEATURE_API_AUDIO | FEATURE_SPEAKER | TIMERS | ANNOUNCE
    voiceAssistantFeatureFlags: 1 | 2 | 4 | 8 | 16,
};

describe('discovery probe never sends VoiceAssistantConfigurationRequest', () => {
    it('settles capabilities from DeviceInfoResponse without asking for the VA config', async () => {
        const { client, sent, capabilities } = makeProbe(true);

        await handshake(client, VOICE_PE);

        expect(sent).not.toContain('VoiceAssistantConfigurationRequest');
        expect(sent).not.toContain('SubscribeVoiceAssistantRequest');
        expect(capabilities).toHaveLength(1);

        const [mediaPlayers, subscribeVa, vaConfig, deviceType] = capabilities[0];
        expect(mediaPlayers).toBe(1);
        expect(subscribeVa).toBeGreaterThan(0);
        expect(vaConfig).toBeGreaterThan(0);
        expect(deviceType).toBe('pe');
    });

    it('accepts legacy firmware that reports only legacy_voice_assistant_version', async () => {
        const { client, capabilities } = makeProbe(true);

        await handshake(client, {
            name: 'home-assistant-voice-09xyz',
            manufacturer: 'Nabu Casa',
            legacyVoiceAssistantVersion: 2,
            voiceAssistantFeatureFlags: 0,
        });

        expect(capabilities[0][2]).toBeGreaterThan(0);
    });

    it('reports a non-voice ESPHome node as having no voice-assistant support', async () => {
        const { client, capabilities } = makeProbe(true);

        await handshake(client, { name: 'some-esphome-relay', manufacturer: 'Espressif' }, false);

        expect(capabilities).toHaveLength(1);
        expect(capabilities[0][0]).toBe(0);  // no media player
        expect(capabilities[0][2]).toBe(0);  // no voice assistant
        expect(capabilities[0][3]).toBeNull();
    });

    it('still asks for the VA config on a real (subscribed) connection', async () => {
        const { client, sent, capabilities } = makeProbe(false);

        await handshake(client, VOICE_PE);

        expect(sent).toContain('VoiceAssistantConfigurationRequest');
        // The real connection waits for the response before announcing capabilities.
        expect(capabilities).toHaveLength(0);
    });
});
