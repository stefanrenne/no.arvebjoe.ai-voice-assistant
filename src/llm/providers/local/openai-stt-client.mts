import { pcmToWav } from '../../../helpers/wav.mjs';
import { createLogger } from '../../../helpers/logger.mjs';
import { ISttClient } from './stt-client.mjs';
import { normalizeOpenAiBaseUrl, openAiAuthHeaders, checkOpenAiCompatServer, openAiCompatNeedsKey } from './openai-compat.mjs';

/**
 * ISttClient for any OpenAI-compatible transcription server.
 *
 * POST {base}/audio/transcriptions — multipart WAV upload, JSON { text }
 * back. Point it at OpenAI itself (model gpt-4o-transcribe / whisper-1),
 * Groq (whisper-large-v3-turbo at https://api.groq.com/openai/v1), or a LAN
 * server like speaches. Differs from WhisperClient's 'openai' flavor in that
 * the URL is free-form (not host:port), a Bearer key is supported, and the
 * model field is configurable (cloud services require it).
 */

export interface OpenAiSttConfig {
    baseUrl: string;
    /** Optional — LAN servers usually need none. */
    apiKey: string;
    /** Model id — required by cloud services, often optional on LAN servers. */
    model: string;
    /** Free-text context about the recording ('prompt'). Optional. */
    prompt?: string;
    /** Expected terms — device/room/artist names. Comma-separated. Optional. */
    keywords?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 5_000;

/** OpenAI's cap on the prompt field (whisper-1 docs). Trim rather than 400. */
const MAX_PROMPT_CHARS = 800;

/**
 * Models that take `keywords[]` as a separate field: OpenAI's gpt-transcribe
 * family (`gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`,
 * `-diarize`, …). Everything else — whisper-1, Groq's whisper-large-v3, a LAN
 * speaches — has no such field and gets the keywords folded into `prompt`,
 * which is exactly the documented whisper technique: "pass a string of correct
 * spellings to the prompt parameter". Sending `keywords[]` to those would be a
 * 400 on OpenAI and silently ignored elsewhere, so we never do.
 */
function supportsKeywordsField(model: string): boolean {
    return /transcribe/i.test(model) && /^gpt/i.test(model.trim());
}

/** Comma/newline separated -> trimmed, de-duplicated, non-empty terms. */
function parseKeywords(raw: string | undefined): string[] {
    const seen = new Set<string>();
    for (const part of String(raw ?? '').split(/[,\n]/)) {
        const term = part.trim();
        if (term) seen.add(term);
    }
    return [...seen];
}

export class OpenAiSttClient implements ISttClient {
    private config: OpenAiSttConfig;
    private logger = createLogger('OPENAI_STT', true);

    constructor(config: OpenAiSttConfig) {
        this.config = { ...config };
    }

    configure(config: OpenAiSttConfig): void {
        this.config = { ...config };
    }

    private get baseUrl(): string {
        return normalizeOpenAiBaseUrl(this.config.baseUrl);
    }

    describe(): string {
        const { prompt, keywords } = this.buildContextFields();
        const context = prompt || keywords.length ? ` +context(${prompt.length}c${keywords.length ? `,${keywords.length}kw` : ''})` : '';
        return `openai-stt=${this.config.model || 'server-default'}@${this.baseUrl}${context}`;
    }

    isConfigured(): boolean {
        return !!this.config.baseUrl;
    }

    /**
     * Keyless LAN servers are fine, but a known cloud host (OpenAI, Groq, …)
     * without a key can only ever 401 — report that as missing credentials so
     * the device says so up front instead of failing mid-turn.
     */
    hasCredentials(): boolean {
        return !!this.config.apiKey || !openAiCompatNeedsKey(this.config.baseUrl);
    }

    async check(): Promise<void> {
        await checkOpenAiCompatServer(this.baseUrl, this.config.apiKey, PROBE_TIMEOUT_MS);
    }

    /**
     * The `prompt` / `keywords[]` fields for this request.
     *
     * `language` alone is a weak hint on short utterances — a two-word command
     * still gets transcribed into a neighbouring language. `prompt` is the
     * documented lever: free text for the gpt-transcribe family, a list of
     * correct spellings for whisper-1. Keywords ride in whichever field the
     * model actually has (see supportsKeywordsField).
     *
     * Exposed for the unit test; the shape is what goes on the wire.
     */
    buildContextFields(): { prompt: string; keywords: string[] } {
        const keywords = parseKeywords(this.config.keywords);
        const asField = keywords.length > 0 && supportsKeywordsField(this.config.model);
        const parts = [String(this.config.prompt ?? '').trim()];
        if (keywords.length && !asField) parts.push(keywords.join(', '));
        return {
            prompt: parts.filter(Boolean).join(' ').slice(0, MAX_PROMPT_CHARS),
            keywords: asField ? keywords : [],
        };
    }

    async transcribe(pcm16k: Buffer, languageCode: string): Promise<string> {
        const wav = pcmToWav(pcm16k, 16000, 1);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'audio.wav');
        if (this.config.model) form.append('model', this.config.model);
        if (languageCode) form.append('language', languageCode);
        const { prompt, keywords } = this.buildContextFields();
        if (prompt) form.append('prompt', prompt);
        for (const term of keywords) form.append('keywords[]', term);
        form.append('response_format', 'json');

        const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: openAiAuthHeaders(this.config.apiKey),
            body: form,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
            const detail = await res.text().catch(() => '');
            throw new Error(`${this.baseUrl}/audio/transcriptions returned HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
        }

        const raw = (await res.text()).trim();
        try {
            const json = JSON.parse(raw);
            return String(json?.text ?? '').trim();
        } catch {
            return raw; // some servers answer text/plain
        }
    }
}
