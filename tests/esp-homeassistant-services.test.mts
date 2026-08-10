import { describe, it, expect } from 'vitest';
import { encodeFrame, decodeFrame } from '../src/voice_assistant/esp-messages.mjs';

// The subscribe (id 34) / event (id 35) pair that stops a device's own
// `homeassistant.event` actions being discarded with "client has not subscribed
// to actions (yet)". Both come straight from api.proto via the (id) option, so
// these tests mainly pin that they resolve by name and that the payload shape
// is the one the client's handler reads.

describe('Home Assistant services subscription', () => {
    it('resolves SubscribeHomeassistantServicesRequest by name', () => {
        const decoded = decodeFrame(encodeFrame('SubscribeHomeassistantServicesRequest', {}));
        expect(decoded!.name).toBe('SubscribeHomeassistantServicesRequest');
    });

    it('roundtrips a device-fired event with its data payload', () => {
        // Shaped like the ReSpeaker's `esphome.tts_uri` action.
        const frame = encodeFrame('HomeassistantServiceResponse', {
            service: 'esphome.tts_uri',
            isEvent: true,
            data: [{ key: 'uri', value: 'http://192.168.1.107/app/x/userdata/audio/tx_1.flac' }],
        });
        const decoded = decodeFrame(frame)!;

        expect(decoded.name).toBe('HomeassistantServiceResponse');
        expect(decoded.message.service).toBe('esphome.tts_uri');
        expect(decoded.message.isEvent).toBe(true);
        // HomeassistantServiceMap is {key, value}, NOT the {name, value} that
        // VoiceAssistantEventResponse.data uses — the handler formats on `key`.
        expect(decoded.message.data[0].key).toBe('uri');
        expect(decoded.message.data[0].value).toContain('tx_1.flac');
    });

    it('roundtrips an event with no data (esphome.wake_word_detected)', () => {
        const decoded = decodeFrame(encodeFrame('HomeassistantServiceResponse', {
            service: 'esphome.wake_word_detected',
            isEvent: true,
        }))!;

        expect(decoded.message.service).toBe('esphome.wake_word_detected');
        expect(decoded.message.data ?? []).toHaveLength(0);
    });
});
