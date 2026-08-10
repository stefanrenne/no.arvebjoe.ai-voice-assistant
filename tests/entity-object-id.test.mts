// object_id derivation — ESPHome 2026.7.0+ never sends ListEntities*.object_id
// (and 2026.1-2026.6 skip it for the API 1.14 we now advertise), so the client
// reconstructs it from the entity name. The rule mirrors ESPHome's own
// EntityBase::write_object_id_to(): snake_case then sanitize, per UTF-8 byte.
import { describe, it, expect } from 'vitest';
import { computeObjectId, resolveEntityObjectId } from '../src/voice_assistant/entity-object-id.mjs';
import { EspVoiceAssistantClient } from '../src/voice_assistant/esp-voice-assistant-client.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';

describe('computeObjectId', () => {
    it('reproduces the ids our entity lookups key on', () => {
        // PE / ThirdReality
        expect(computeObjectId('Mute')).toBe('mute');
        expect(computeObjectId('Media Player')).toBe('media_player');
        // ReSpeaker XVF3800
        expect(computeObjectId('Microphone Mute')).toBe('microphone_mute');
        expect(computeObjectId('Mute Sound')).toBe('mute_sound');
    });

    it('lowercases, turns spaces into underscores and keeps digits, - and _', () => {
        expect(computeObjectId('Wake Word 2')).toBe('wake_word_2');
        expect(computeObjectId('beam-lock_state')).toBe('beam-lock_state');
    });

    it('replaces every other character with an underscore', () => {
        expect(computeObjectId('Volume (dB)')).toBe('volume__db_');
        expect(computeObjectId('Mic: level!')).toBe('mic__level_');
    });

    it('substitutes one underscore per UTF-8 byte, like the firmware', () => {
        // ESPHome sanitizes bytes, so a 3-byte character becomes three
        // underscores — not one. aioesphomeapi (Python chars) differs here; the
        // firmware is the authority on what it would have sent.
        expect(computeObjectId('温度')).toBe('______');
    });

    it('truncates at 127 bytes (the firmware object_id buffer)', () => {
        expect(computeObjectId('a'.repeat(200))).toHaveLength(127);
    });

    it('yields an empty id for a nameless entity', () => {
        expect(computeObjectId('')).toBe('');
        expect(computeObjectId(undefined)).toBe('');
    });
});

describe('resolveEntityObjectId', () => {
    it('prefers what the device sent (<= 2026.6 firmware)', () => {
        expect(resolveEntityObjectId({ objectId: 'microphone_mute', name: 'Renamed Later' }))
            .toBe('microphone_mute');
    });

    it('derives from the name when the device omits it (2026.7.0+)', () => {
        // object_id is declared (force) = true, so it arrives as an empty string
        // rather than being absent.
        expect(resolveEntityObjectId({ objectId: '', name: 'Microphone Mute' }))
            .toBe('microphone_mute');
    });
});

describe('entity registration on firmware that omits object_id', () => {
    function makeClient(): EspVoiceAssistantClient {
        return new EspVoiceAssistantClient(new MockHomey(), {
            host: '127.0.0.1',
            discoveryMode: false,
            logLevel: 0,
        });
    }

    async function listEntities(
        client: EspVoiceAssistantClient,
        entities: Array<[string, Record<string, any>]>,
    ): Promise<Record<string, number>> {
        for (const [name, message] of entities) {
            await (client as any).dispatch({ name, message });
        }
        return (client as any).entityKeys;
    }

    it('finds the PE mute switch from its name alone', async () => {
        const keys = await listEntities(makeClient(), [
            ['ListEntitiesSwitchResponse', { objectId: '', name: 'Mute', key: 11 }],
        ]);
        expect(keys['mute']).toBe(11);
    });

    it('still prefers the ReSpeaker mic mute over its mute-chime switch', async () => {
        // Same trap as the object_id path: mute_sound is listed first.
        const keys = await listEntities(makeClient(), [
            ['ListEntitiesSwitchResponse', { objectId: '', name: 'Mute Sound', key: 1 }],
            ['ListEntitiesSwitchResponse', { objectId: '', name: 'Microphone Mute', key: 2 }],
        ]);
        expect(keys['mute']).toBe(2);
        expect(keys['microphone_mute']).toBe(2);
        expect(keys['mute_sound']).toBe(1);
    });

    it('finds a volume number entity from its name', async () => {
        const keys = await listEntities(makeClient(), [
            ['ListEntitiesNumberResponse', { objectId: '', name: 'Volume', key: 5 }],
        ]);
        expect(keys['volume']).toBe(5);
    });

    it('registers the primary media player even with nothing to derive an id from', async () => {
        // `name: None` entities send an empty name too, and the firmware would
        // fall back to the device name — but the primary media player is keyed on
        // the entity key alone, so playback survives.
        const keys = await listEntities(makeClient(), [
            ['ListEntitiesMediaPlayerResponse', { objectId: '', name: '', key: 77 }],
        ]);
        expect(keys['media_player']).toBe(77);
    });

    it('attributes a button press to the derived event-entity id', async () => {
        const client = makeClient();
        const events: Array<[string, string]> = [];
        client.on('entity_event', (objectId, eventType) => events.push([objectId, eventType]));

        await (client as any).dispatch({
            name: 'ListEntitiesEventResponse',
            message: { objectId: '', name: 'Button Press', key: 42, eventTypes: ['single_press'] },
        });
        await (client as any).dispatch({
            name: 'EventResponse',
            message: { key: 42, eventType: 'single_press' },
        });

        expect(events).toEqual([['button_press', 'single_press']]);
    });

    it('keeps using the sent object_id when the firmware still provides one', async () => {
        // Older firmware wins over the derivation: a device whose object_id was
        // customised must not be re-keyed to something derived from its name.
        const keys = await listEntities(makeClient(), [
            ['ListEntitiesSwitchResponse', { objectId: 'mute', name: 'Silence The Mic', key: 9 }],
        ]);
        expect(keys['mute']).toBe(9);
        expect(keys['silence_the_mic']).toBeUndefined();
    });
});
