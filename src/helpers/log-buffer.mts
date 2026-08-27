/**
 * In-memory ring buffer of the app's recent log lines — the source for the
 * "Dump log" button in Settings → Debug.
 *
 * Why this exists: Homey's *Create Diagnostics Report* submits only a short tail
 * of recent lines and has to be pressed right after the failure, and the SDK has
 * no hook to enrich or trigger it. Verbose logging makes that channel WORSE —
 * ESP/PE/AGENT chatter pushes the connect and handshake lines out of the window
 * first. So the buffer is ours: every Logger routes here, *including the quieted
 * subsystem loggers whether or not verbose logging is on*, so a dump always
 * contains the lines that say whether the satellite and the AI engine connected.
 *
 * Privacy: redaction happens at WRITE time (`redactForDump`), not at dump time,
 * so the buffer never holds what should not leave the house — spoken
 * transcripts and API keys. LAN IPs are deliberately kept: they are private
 * addresses and are exactly what lets a user see for themselves which device
 * the app is failing to reach.
 */

export type LogBufferLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogBufferEntry {
    /** Epoch ms. */
    at: number;
    level: LogBufferLevel;
    /** Logger name (upper-cased), e.g. "ESP", "CONVO". */
    from: string;
    /** Sub-tag, e.g. "STT", "TOOL", "WARN"; '' when none. */
    sub: string;
    /** Redacted, ANSI-free text; details (if any) appended on the same line. */
    text: string;
}

/** Default capacity: ~2000 lines is a few hundred KB and covers a long session. */
export const LOG_BUFFER_CAPACITY = 2000;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Secrets that may appear INSIDE a message string (details fields are masked
// separately by the logger's maskSecrets). OpenAI-style keys, bearer tokens,
// and 44-char base64 blobs (the shape of an ESPHome Noise API key).
const INLINE_SECRET_RES: RegExp[] = [
    /\bsk-[A-Za-z0-9_-]{10,}/g,
    /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{10,}/gi,
    /(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/=])/g,
];

// Lines that carry what a person said in their home, or what the assistant
// answered. Each pattern captures the prefix to keep; the quoted/trailing text
// after it is replaced by a length marker so the line shape stays debuggable
// ("Heard: <17 chars>" still says STT produced something).
const TRANSCRIPT_RES: { re: RegExp; quoted: boolean }[] = [
    { re: /^(Heard: )"(.*)"$/s, quoted: true },
    { re: /^(Reply: )"(.*)"$/s, quoted: true },
    { re: /^(Flow question \([^)]*\): )"(.*)"$/s, quoted: true },
    { re: /^(STT \d+ms: )"(.*)"$/s, quoted: true },
    { re: /^(No LLM backend — transcript handed to Flows: )"(.*)"$/s, quoted: true },
    { re: /^(Final transcript: )(.*)$/s, quoted: false },
    { re: /^(LLM reply: )(.*)$/s, quoted: false },
    { re: /^(Converting text to speech: )(.*)$/s, quoted: false },
    { re: /^(Speaking text: )(.*)$/s, quoted: false },
    { re: /^(Asking agent to output (?:to speaker|as text): )(.*)$/s, quoted: false },
    // OpenAI Realtime transcript deltas: "response.output_audio_transcript.delta = Kl".
    { re: /^([\w.]*transcript[\w.]*\.delta = )(.*)$/s, quoted: false },
];

// Field names whose string values are what was said or asked — in ESP event
// payloads, provider messages and tool arguments/results alike.
const TEXT_KEY_RE = /^(text|transcript|delta|chat_log_delta|query|question|item|content|prompt|reply|user_text|userText)$/i;
// ESP VoiceAssistantEvent data entries: { name: 'text' | 'chat_log_delta', value: '…' }.
const TEXT_NAMED_VALUE_RE = /^(text|chat_log_delta)$/i;
// The same fields inside a JSON string (tool results are logged as JSON text).
const JSON_TEXT_FIELD_RE = /"(text|transcript|query|question|item|content|prompt|reply)":"((?:[^"\\]|\\.)*)"/g;
// "query=…" in the TOOL lines (web_search, search_music, play_music).
const QUERY_KV_RE = /\b(query=)([^,]*)/g;

const redactedMarker = (s: string): string => `<${s.length} chars redacted>`;

/**
 * Deep copy of `details` with text-bearing string fields replaced by a length
 * marker. Only plain objects/arrays are walked (Buffers, Errors, class
 * instances pass through), mirroring the logger's maskSecrets.
 */
export function redactDetails(details: any): any {
    if (Array.isArray(details)) {
        return details.map(redactDetails);
    }
    if (details && typeof details === 'object' &&
        (details.constructor === Object || details.constructor === undefined)) {
        const out: Record<string, any> = {};
        const namedText = typeof details.name === 'string' && TEXT_NAMED_VALUE_RE.test(details.name);
        for (const [key, value] of Object.entries(details)) {
            if (typeof value === 'string' && value && (TEXT_KEY_RE.test(key) || (namedText && key === 'value'))) {
                out[key] = redactedMarker(value);
            } else {
                out[key] = redactDetails(value);
            }
        }
        return out;
    }
    return details;
}

// A precise coordinate pair is the user's home address. Keep one decimal
// (~10 km) — enough to see the weather/timezone lookups used the right area.
const COORD_PAIR_RE = /(-?\d{1,3}\.\d{4,}),\s*(-?\d{1,3}\.\d{4,})/g;

function maskInline(text: string): string {
    let out = text.replace(COORD_PAIR_RE, (_m, a: string, b: string) => `${Number(a).toFixed(1)}, ${Number(b).toFixed(1)} (approx.)`);
    out = out.replace(JSON_TEXT_FIELD_RE, (_m, key: string, val: string) => `"${key}":"${redactedMarker(val)}"`);
    out = out.replace(QUERY_KV_RE, (_m, key: string, val: string) => `${key}${val ? redactedMarker(val) : ''}`);
    for (const re of INLINE_SECRET_RES) {
        out = out.replace(re, (m: string, g1?: string) => {
            const keep = m.length > 8 ? `${m.slice(0, 4)}....${m.slice(-4)}` : '....';
            return g1 && /^bearer$/i.test(g1) ? `${g1} ....` : keep;
        });
    }
    return out;
}

/**
 * Strip colors, hide transcripts, coarsen coordinates and mask inline secrets. Exported for tests and for
 * anything else that wants the dump's exact redaction rules.
 */
export function redactForDump(message: string): string {
    const plain = message.replace(ANSI_RE, '');
    for (const { re, quoted } of TRANSCRIPT_RES) {
        const m = plain.match(re);
        if (m) {
            const marker = `<${m[2].length} chars redacted>`;
            return maskInline(`${m[1]}${quoted ? `"${marker}"` : marker}`);
        }
    }
    return maskInline(plain);
}

class LogBuffer {
    private entries: (LogBufferEntry | undefined)[];
    private next = 0;
    private count = 0;
    private dropped = 0;

    constructor(private readonly capacity: number = LOG_BUFFER_CAPACITY) {
        this.entries = new Array(capacity);
    }

    push(level: LogBufferLevel, from: string, sub: string, text: string, at: number = Date.now()): void {
        if (this.count === this.capacity) {
            this.dropped++;
        }
        this.entries[this.next] = { at, level, from, sub, text };
        this.next = (this.next + 1) % this.capacity;
        if (this.count < this.capacity) {
            this.count++;
        }
    }

    /** Oldest → newest. */
    snapshot(): LogBufferEntry[] {
        const out: LogBufferEntry[] = [];
        const start = this.count === this.capacity ? this.next : 0;
        for (let i = 0; i < this.count; i++) {
            const e = this.entries[(start + i) % this.capacity];
            if (e) out.push(e);
        }
        return out;
    }

    size(): number {
        return this.count;
    }

    /** Lines that have fallen off the front since start (or the last clear). */
    droppedCount(): number {
        return this.dropped;
    }

    /** Tests only. */
    clear(): void {
        this.entries = new Array(this.capacity);
        this.next = 0;
        this.count = 0;
        this.dropped = 0;
    }
}

export const logBuffer = new LogBuffer();

/** Build a fresh buffer with its own capacity (tests). */
export function createLogBuffer(capacity: number): LogBuffer {
    return new LogBuffer(capacity);
}

const LEVEL_TAG: Record<LogBufferLevel, string> = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' };

/** One dump line: `2026-08-27 21:03:11.482 INF [ESP][TX] text`. */
export function formatEntry(e: LogBufferEntry, timeZone?: string): string {
    return `${formatTimestamp(e.at, timeZone)} ${LEVEL_TAG[e.level]} [${e.from}]${e.sub ? `[${e.sub}]` : ''} ${e.text}`;
}

/** Local wall-clock with ms, in the given IANA zone (falls back to the host's). */
export function formatTimestamp(at: number, timeZone?: string): string {
    const d = new Date(at);
    let parts: Record<string, string> = {};
    try {
        const fmt = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        });
        for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
    } catch {
        parts = {};
    }
    if (!parts.year) {
        const pad = (n: number, w = 2) => String(n).padStart(w, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
    }
    const hour = parts.hour === '24' ? '00' : parts.hour;
    return `${parts.year}-${parts.month}-${parts.day} ${hour}:${parts.minute}:${parts.second}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
