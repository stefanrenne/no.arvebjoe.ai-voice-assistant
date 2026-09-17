// Flat fast-path tool set, generated from a snapshot of the Homey home.
//
// Unlike ToolManager's tools (get_devices -> set_device_capability by id), every
// tool here resolves in ONE call: targets are enums of the real zone and device
// names, so constrained decoding can only produce values that exist. In the app
// the snapshot would come from DeviceManager (zones + devices by class) and the
// engine would be re-initialised on a zone-change callback.
//
// Rules carried over from needle.environments.smart_home:
//  - every closed set is an enum, every number has bounds;
//  - no correct call ever needs a value the user did not say;
//  - avoid enum values that hide inside likely query words.

// Performance cliff: with <= 5 tools they are rendered directly (~250 ms/turn on
// an M-series Mac). Above 5 the retrieval head engages and every turn re-selects
// and re-prefills a top-5 subset with a rebuilt grammar (~2.8 s/turn in WASM).
export const DEFAULT_TOOLS = ['control_lights', 'switch_device', 'set_thermostat', 'set_timer', 'add_to_shopping_list'];

// The system turn carries environment FACTS, not instructions — Needle ignores
// instructions there (doc/apis.md "System facts"). Recognized keys: date,
// locale, device, battery, network, location, user, assistant.
const LOCALES = {
    en: 'en-GB', nl: 'nl-NL', no: 'nb-NO', da: 'da-DK', sv: 'sv-SE', de: 'de-DE',
    es: 'es-ES', fr: 'fr-FR', it: 'it-IT', pl: 'pl-PL', ru: 'ru-RU', ko: 'ko-KR',
};
export const systemFacts = (lang) => `locale: ${LOCALES[lang] ?? lang}; device: smart speaker`;

const enumOf = (values, description) => ({ type: 'string', enum: values, description });

/**
 * @param {{ lightZones: string[], thermostatZones: string[], blindZones: string[], switches: string[] }} home
 */
export function buildTools(home) {
    return [
        {
            name: 'control_lights',
            description: 'Turn the lights in one stated zone on or off, or dim them to a stated percentage. Never use this for switches, blinds or heating.',
            parameters: {
                type: 'object',
                properties: {
                    zone: enumOf(home.lightZones, 'The zone whose lights to control.'),
                    action: enumOf(['on', 'off', 'dim'], 'on, off, or dim.'),
                    brightness_percent: { type: 'integer', minimum: 1, maximum: 100, description: 'Brightness; only for dim, only when stated.' },
                },
                required: ['zone', 'action'],
            },
        },
        {
            name: 'switch_device',
            description: 'Turn one named device on or off. Never use this for lights in a zone.',
            parameters: {
                type: 'object',
                properties: {
                    device: enumOf(home.switches, 'The device to switch.'),
                    action: enumOf(['on', 'off'], 'on or off.'),
                },
                required: ['device', 'action'],
            },
        },
        {
            name: 'set_thermostat',
            description: 'Set the target temperature in degrees Celsius for one stated zone.',
            parameters: {
                type: 'object',
                properties: {
                    zone: enumOf(home.thermostatZones, 'The zone whose thermostat to set.'),
                    temperature: { type: 'number', minimum: 5, maximum: 30, description: 'Target temperature in degrees Celsius.' },
                },
                required: ['zone', 'temperature'],
            },
        },
        {
            name: 'control_blinds',
            description: 'Open or close the blinds in one stated zone.',
            parameters: {
                type: 'object',
                properties: {
                    zone: enumOf(home.blindZones, 'The zone whose blinds to move.'),
                    action: enumOf(['open', 'close'], 'open or close.'),
                },
                required: ['zone', 'action'],
            },
        },
        {
            name: 'set_timer',
            description: 'Start a countdown timer for a stated duration.',
            parameters: {
                type: 'object',
                properties: {
                    minutes: { type: 'integer', minimum: 0, maximum: 600, description: 'Whole minutes, when stated.' },
                    seconds: { type: 'integer', minimum: 0, maximum: 3600, description: 'Seconds, when stated.' },
                },
            },
        },
        {
            name: 'add_to_shopping_list',
            description: 'Add one or more stated items to the shopping list.',
            parameters: {
                type: 'object',
                properties: {
                    items: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'The items exactly as said.' },
                },
                required: ['items'],
            },
        },
        {
            // Not in DEFAULT_TOOLS: a decoy that absorbs "play <something> in
            // <zone>", which otherwise becomes control_lights(zone, on).
            name: 'play_music',
            description: 'Play music that the user asks for by name, artist, genre or mood, optionally in one stated zone.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'What to play, as said.' },
                    zone: enumOf(home.lightZones, 'The zone to play in, when stated.'),
                },
                required: ['query'],
            },
        },
        {
            name: 'control_music',
            description: 'Control music playback that is already set up: pause, resume, next or previous track, volume up or down. Never use this to pick something new to play.',
            parameters: {
                type: 'object',
                properties: {
                    action: enumOf(['pause', 'resume', 'next', 'previous', 'volume_up', 'volume_down'], 'The playback action.'),
                },
                required: ['action'],
            },
        },
    ];
}
