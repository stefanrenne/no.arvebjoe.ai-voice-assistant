/**
 * Shared bits for the generic "OpenAI-compatible" pipeline backends.
 *
 * Nearly the whole ecosystem speaks OpenAI's API dialect these days — Groq,
 * OpenRouter, DeepSeek, Together (cloud); LM Studio, llama.cpp, vLLM,
 * LocalAI (local LLMs); speaches (STT); kokoro-fastapi (TTS); and OpenAI
 * itself — so one configurable backend per stage covers all of them. Each
 * stage gets its own base URL / API key / model settings, since STT, LLM and
 * TTS may well point at different servers.
 */

/**
 * Normalize a user-entered base URL:
 *   - trims and strips trailing slashes
 *   - defaults a bare host to http:// (LAN servers) — full URLs keep their scheme
 *   - appends `/v1` when no path was given, since every known server roots the
 *     API there (OpenAI api.openai.com/v1, LM Studio localhost:1234/v1, …).
 *     A URL that already has a path (e.g. Groq's /openai/v1) is kept verbatim.
 */
export function normalizeOpenAiBaseUrl(raw: string): string {
    let url = (raw ?? '').trim().replace(/\/+$/, '');
    if (!url) return '';
    if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
    try {
        const parsed = new URL(url);
        if (parsed.pathname === '' || parsed.pathname === '/') {
            url = `${url}/v1`;
        }
    } catch {
        // Leave malformed input as-is; the request will fail with a clear error.
    }
    return url;
}

/** Authorization header when a key is configured (many local servers need none). */
export function openAiAuthHeaders(apiKey: string): Record<string, string> {
    return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/**
 * Reachability probe for an OpenAI-compatible server: GET {base}/models.
 * 401/403 mean "server is there but the key is wrong/missing" — thrown with a
 * key-shaped message. A 404 is tolerated (some minimal servers skip /models);
 * only an unreachable server rejects otherwise.
 */
export async function checkOpenAiCompatServer(baseUrl: string, apiKey: string, timeoutMs: number): Promise<void> {
    const res = await fetch(`${baseUrl}/models`, {
        headers: openAiAuthHeaders(apiKey),
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) {
        throw new Error(`${baseUrl} rejected the API key (HTTP ${res.status}) — check it in the app settings`);
    }
}

/**
 * OpenAI's standard TTS voices (tts-1 / gpt-4o-mini-tts), offered in the main
 * Voice dropdown when the TTS backend is 'openai'. Custom servers (Kokoro etc.)
 * use the free-text voice override instead.
 */
export const OPENAI_TTS_VOICES: { value: string; name: string }[] = [
    { value: 'alloy', name: 'Alloy' },
    { value: 'ash', name: 'Ash' },
    { value: 'ballad', name: 'Ballad' },
    { value: 'coral', name: 'Coral' },
    { value: 'echo', name: 'Echo' },
    { value: 'fable', name: 'Fable' },
    { value: 'nova', name: 'Nova' },
    { value: 'onyx', name: 'Onyx' },
    { value: 'sage', name: 'Sage' },
    { value: 'shimmer', name: 'Shimmer' },
    { value: 'verse', name: 'Verse' },
];

const OPENAI_TTS_VOICE_IDS = new Set(OPENAI_TTS_VOICES.map((v) => v.value));

/** True when the app's `selected_voice` is a standard OpenAI TTS voice. */
export function isOpenAiTtsVoice(voice: string | undefined | null): boolean {
    return !!voice && OPENAI_TTS_VOICE_IDS.has(voice);
}

/**
 * A ready-made server for one pipeline stage.
 *
 * Typing `https://api.openai.com/v1` by hand to use OpenAI itself is a poor
 * first experience for the most obvious choice, so the settings page offers
 * these as a "Server" dropdown per stage: picking one fills in the base URL
 * and a sensible model, and only the "Custom" entry (empty `baseUrl`) shows
 * the free-text URL field. The table lives here rather than in the settings
 * HTML so the app and the page agree on which hosts are cloud services that
 * need a key — see `openAiCompatNeedsKey`.
 */
export interface OpenAiCompatPreset {
    /** Stable id, used as the dropdown value. `custom` = type your own URL. */
    id: string;
    /** Dropdown label. */
    name: string;
    /** Base URL to fill in; empty means "let the user type one". */
    baseUrl: string;
    /** Model prefilled with the preset (empty = leave the field alone). */
    model: string;
    /** True when the server rejects unauthenticated requests. */
    requiresKey: boolean;
    /** Where the user gets a key, shown under the key field. */
    keyUrl: string;
}

const CUSTOM_PRESET: OpenAiCompatPreset = {
    id: 'custom',
    name: 'Custom / self-hosted — enter a URL',
    baseUrl: '',
    model: '',
    requiresKey: false,
    keyUrl: '',
};

const OPENAI_URL = 'https://api.openai.com/v1';
const OPENAI_KEY_URL = 'https://platform.openai.com/api-keys';
const GROQ_URL = 'https://api.groq.com/openai/v1';
const GROQ_KEY_URL = 'https://console.groq.com/keys';

/**
 * Presets per stage. They differ because the stages need different endpoints:
 * Groq serves transcription and chat but its speech API is a different beast,
 * and OpenRouter/DeepSeek are chat-only.
 */
export const OPENAI_COMPAT_PRESETS: Record<'stt' | 'llm' | 'tts', OpenAiCompatPreset[]> = {
    stt: [
        // whisper-1, not a gpt-*-transcribe: it holds the `language` hint far
        // more strictly, and satellite utterances are the 1-2 second clips where
        // the gpt transcribers drift into neighbouring languages (verified on
        // hardware, Norwegian, 2026-08-20). Changing this only affects new
        // setups and anyone re-picking the preset — a saved model id is a
        // stored setting and openaiModelIsPreset() leaves it alone.
        { id: 'openai', name: 'OpenAI', baseUrl: OPENAI_URL, model: 'whisper-1', requiresKey: true, keyUrl: OPENAI_KEY_URL },
        { id: 'groq', name: 'Groq', baseUrl: GROQ_URL, model: 'whisper-large-v3-turbo', requiresKey: true, keyUrl: GROQ_KEY_URL },
        CUSTOM_PRESET,
    ],
    llm: [
        { id: 'openai', name: 'OpenAI', baseUrl: OPENAI_URL, model: 'gpt-5-mini', requiresKey: true, keyUrl: OPENAI_KEY_URL },
        { id: 'groq', name: 'Groq', baseUrl: GROQ_URL, model: 'llama-3.3-70b-versatile', requiresKey: true, keyUrl: GROQ_KEY_URL },
        { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini', requiresKey: true, keyUrl: 'https://openrouter.ai/keys' },
        { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', requiresKey: true, keyUrl: 'https://platform.deepseek.com/api_keys' },
        CUSTOM_PRESET,
    ],
    tts: [
        { id: 'openai', name: 'OpenAI', baseUrl: OPENAI_URL, model: 'gpt-4o-mini-tts', requiresKey: true, keyUrl: OPENAI_KEY_URL },
        CUSTOM_PRESET,
    ],
};

/** host+path of a base URL, scheme- and trailing-slash-insensitive, `/v1` implied. */
function baseUrlKey(raw: string): string {
    const url = (raw ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '');
    if (!url) return '';
    return url.includes('/') ? url : `${url}/v1`;
}

/** The hosts of every preset that authenticates — see `openAiCompatNeedsKey`. */
const KEYED_HOSTS = new Set<string>(
    Object.values(OPENAI_COMPAT_PRESETS)
        .flat()
        .filter((p) => p.requiresKey && p.baseUrl)
        .map((p) => baseUrlKey(p.baseUrl).split('/')[0]),
);

/**
 * True when the base URL points at a known cloud service that rejects
 * unauthenticated requests. Lets a stage report "no credentials" up front
 * (the missing-key error sound) instead of failing mid-turn with a 401, while
 * keyless LAN servers keep working with an empty key.
 */
export function openAiCompatNeedsKey(baseUrl: string): boolean {
    return KEYED_HOSTS.has(baseUrlKey(baseUrl).split('/')[0]);
}
