// Deterministic guards layered on top of the engine's own confidence/validation.
// Each one targets a failure mode observed in the spike run (see README):
//
//  - target-not-said: for a missing target Needle picks the FIRST enum value
//    ("set the thermostat to 21" -> Living room) with high confidence.
//  - question: state questions ("are the kitchen lights on?") come back as calls.
//  - negation: the engine's negation flag misses non-English ("niet", "ikke").
//  - multi-call: parallel calls are where arguments get crossed ("start the
//    coffee machine" -> off); a miss only costs an LLM round trip.

const TARGET_ARGS = new Set(['zone', 'device']);

const NEGATIONS = {
    en: ["don't", 'do not', 'not', 'never', "doesn't", "won't"],
    nl: ['niet', 'nooit', 'geen'],
    no: ['ikke', 'aldri', 'ingen'],
    da: ['ikke', 'aldrig', 'ingen'],
    sv: ['inte', 'aldrig', 'ingen'],
    de: ['nicht', 'nie', 'kein', 'keine'],
    es: ['no', 'nunca', 'ningún'],
    fr: ['pas', 'jamais', 'aucun', 'aucune'],
    it: ['non', 'mai', 'nessun'],
    pl: ['nie', 'nigdy', 'żaden'],
    ru: ['не', 'никогда', 'ни'],
    // Korean negation is a suffix/auxiliary, not a standalone word class; these
    // are the eojeol that actually appear in spoken commands.
    ko: ['마', '마세요', '말고', '안', '아니'],
};
const words = (text) => text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter(Boolean);

// Every word of the enum value must appear as a prefix of some spoken word,
// allowing one trailing letter of inflection: "Stue" ~ "stua", "Kjøkken" ~ "kjøkkenet".
function said(value, spoken) {
    return words(value).every((w) => {
        const stem = w.length >= 4 ? w.slice(0, -1) : w;
        return spoken.some((s) => s.startsWith(stem));
    });
}

/** @returns {string | null} the reason to fall back, or null when all guards pass */
export function guard(calls, { text, lang }) {
    const trimmed = text.trim();
    if (trimmed.endsWith('?')) return 'guard: question';

    const lower = ` ${words(trimmed).join(' ')} `;
    const negation = (NEGATIONS[lang] ?? NEGATIONS.en).find((n) => lower.includes(` ${n} `));
    if (negation) return `guard: negation "${negation}"`;

    if (calls.length > 1) return 'guard: multi-call';

    const spoken = words(trimmed);
    for (const call of calls) {
        for (const [key, value] of Object.entries(call.arguments ?? {})) {
            if (TARGET_ARGS.has(key) && typeof value === 'string' && !said(value, spoken)) {
                return `guard: ${key} "${value}" not said`;
            }
        }
    }
    return null;
}
