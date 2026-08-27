import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { createLogBuffer, logBuffer, redactForDump, redactDetails, formatEntry, formatTimestamp } from '../src/helpers/log-buffer.mjs';
import { createLogger, setVerboseLogging } from '../src/helpers/logger.mjs';
import { writeLogDump, dumpFilename, initLogDumpFolder, DUMP_TTL_MS } from '../src/helpers/log-dump.mjs';

// "Dump log" (Settings → Debug): every Logger line lands in a redacted ring
// buffer, and the button writes it to /userdata/log/<datetime>.txt. See TODO.md
// → "Getting a full log out of a user" for why this exists.

describe('redactForDump', () => {
    it('strips ANSI colors', () => {
        expect(redactForDump('\x1b[36m[ESP]\x1b[0m - connected')).toBe('[ESP] - connected');
    });

    it('hides what was said but keeps the line shape', () => {
        expect(redactForDump('Heard: "turn off the kitchen light"')).toBe('Heard: "<26 chars redacted>"');
        expect(redactForDump('Reply: "Done."')).toBe('Reply: "<5 chars redacted>"');
        expect(redactForDump('STT 812ms: "hello there"')).toBe('STT 812ms: "<11 chars redacted>"');
        expect(redactForDump('Final transcript: hello there')).toBe('Final transcript: <11 chars redacted>');
        expect(redactForDump('LLM reply: it is 21 degrees')).toBe('LLM reply: <16 chars redacted>');
        expect(redactForDump('Flow question (audio out): "Lock the door?"')).toBe('Flow question (audio out): "<14 chars redacted>"');
    });

    it('masks inline secrets', () => {
        expect(redactForDump('using key sk-proj-ABCDEFGHIJKLMNOP1234')).toBe('using key sk-p....1234');
        expect(redactForDump('Authorization: Bearer abcdefghijklmnop')).toBe('Authorization: Bearer ....');
        // 32 bytes base64 — an ESPHome Noise API key.
        const noise = 'Wl0ZSOSyT1mY2mH4hXDm7Vk1p6oOyR8lQ9u4Ftt0p4c=';
        expect(redactForDump(`encryption key ${noise} set`)).toBe('encryption key Wl0Z....p4c= set');
    });

    it('hides the other message-level text carriers', () => {
        expect(redactForDump('Converting text to speech: Klokka er ti')).toBe('Converting text to speech: <12 chars redacted>');
        expect(redactForDump('Speaking text: hei')).toBe('Speaking text: <3 chars redacted>');
        expect(redactForDump('Asking agent to output to speaker: er døra låst?')).toBe('Asking agent to output to speaker: <13 chars redacted>');
        expect(redactForDump('response.output_audio_transcript.delta = Kl')).toBe('response.output_audio_transcript.delta = <2 chars redacted>');
        // Non-transcript deltas are still visible.
        expect(redactForDump('response.function_call_arguments.delta = {"a":1}')).toBe('response.function_call_arguments.delta = {"a":1}');
    });

    it('hides text fields inside logged JSON and query= tool lines', () => {
        expect(redactForDump('web_search → {"ok":true,"query":"weather in Oslo","results":3}'))
            .toBe('web_search → {"ok":true,"query":"<15 chars redacted>","results":3}');
        expect(redactForDump('query=jazz radio, media_type=radio')).toBe('query=<10 chars redacted>, media_type=radio');
    });

    it('redactDetails hides ESP event text, transcripts and deltas but keeps structure', () => {
        const esp = { eventType: 4, data: [{ name: 'text', value: 'Hvor mye er klokka?' }, { name: 'code', value: 'x' }] };
        expect(redactDetails(esp)).toEqual({ eventType: 4, data: [{ name: 'text', value: '<19 chars redacted>' }, { name: 'code', value: 'x' }] });
        const delta = { eventType: 100, data: [{ name: 'chat_log_delta', value: 'Kl' }] };
        expect(redactDetails(delta).data[0].value).toBe('<2 chars redacted>');
        const oai = { type: 'conversation.item.input_audio_transcription.completed', transcript: 'hello', item_id: 'i1' };
        expect(redactDetails(oai)).toEqual({ type: 'conversation.item.input_audio_transcription.completed', transcript: '<5 chars redacted>', item_id: 'i1' });
        // Not a plain object → untouched.
        const buf = Buffer.from('x');
        expect(redactDetails(buf)).toBe(buf);
    });

    it('coarsens a precise coordinate pair — that is the home address', () => {
        expect(redactForDump('Location updated: 60.64966284878184, 10.971575660420262'))
            .toBe('Location updated: 60.6, 11.0 (approx.)');
        // Ordinary decimals are untouched.
        expect(redactForDump('temperature: 17.3, humidity: 56.2')).toBe('temperature: 17.3, humidity: 56.2');
    });

    it('masks camelCase key fields in details', () => {
        const homey = { log: vi.fn(), error: vi.fn() } as any;
        logBuffer.clear();
        const lg = createLogger('KEYS-DUMP');
        lg.setHomey(homey);
        lg.info('pairing', 'PAIR', { encryptionKey: 'Wl0ZSOSyT1mY2mH4hXDm7Vk1p6oOyR8lQ9u4Ftt0p4c=', address: '192.168.0.50' });
        const [e] = logBuffer.snapshot();
        expect(e.text).toContain("encryptionKey: 'Wl0Z....p4c='");
        expect(e.text).toContain("address: '192.168.0.50'");
    });

    it('captures ESP STT_END / INTENT_PROGRESS events without the spoken text', () => {
        const homey = { log: vi.fn(), error: vi.fn() } as any;
        logBuffer.clear();
        const lg = createLogger('ESP-DUMP', true);
        lg.setHomey(homey);
        lg.info('VoiceAssistantEvent: STT_END', 'TX', { eventType: 4, data: [{ name: 'text', value: 'Hvor mye er klokka?' }] });
        lg.info('Text response received:', undefined, 'Klokka er 22:42.');
        const [a, b] = logBuffer.snapshot();
        expect(a.text).toBe("VoiceAssistantEvent: STT_END | { eventType: 4, data: [ { name: 'text', value: '<19 chars redacted>' } ] }");
        expect(b.text).toBe('Text response received: | <16 chars redacted>');
    });

    it('keeps private LAN addresses — they help the user self-diagnose', () => {
        expect(redactForDump('Connecting to 192.168.0.42:6053')).toBe('Connecting to 192.168.0.42:6053');
    });
});

describe('log ring buffer', () => {
    it('keeps the newest N lines, oldest first, and counts what fell off', () => {
        const buf = createLogBuffer(3);
        for (let i = 1; i <= 5; i++) buf.push('info', 'T', '', `line ${i}`, i);
        expect(buf.size()).toBe(3);
        expect(buf.snapshot().map((e) => e.text)).toEqual(['line 3', 'line 4', 'line 5']);
        expect(buf.droppedCount()).toBe(2);
    });

    it('formats a line with level, logger and sub-tag', () => {
        const e = { at: Date.UTC(2026, 7, 27, 19, 3, 11, 482), level: 'warn' as const, from: 'ESP', sub: 'WARN', text: 'ping timeout' };
        expect(formatEntry(e, 'UTC')).toBe('2026-08-27 19:03:11.482 WRN [ESP][WARN] ping timeout');
    });

    it('renders the timestamp in the requested zone', () => {
        const at = Date.UTC(2026, 7, 27, 22, 30, 0, 5);
        expect(formatTimestamp(at, 'Europe/Oslo')).toBe('2026-08-28 00:30:00.005');
    });
});

describe('Logger → buffer', () => {
    beforeEach(() => logBuffer.clear());
    afterEach(() => setVerboseLogging(false));

    it('captures quieted loggers even with verbose logging off', () => {
        const homey = { log: vi.fn(), error: vi.fn() } as any;
        const quiet = createLogger('QUIET-DUMP', true);
        quiet.setHomey(homey);
        quiet.info('ESP connected to 192.168.0.42', 'TX');

        expect(homey.log).not.toHaveBeenCalled();
        const [e] = logBuffer.snapshot();
        expect(e.level).toBe('debug');
        expect(e.from).toBe('QUIET-DUMP');
        expect(e.sub).toBe('TX');
        expect(e.text).toBe('ESP connected to 192.168.0.42');
    });

    it('records info/warn/error at their level, with details masked and appended', () => {
        const homey = { log: vi.fn(), error: vi.fn() } as any;
        const lg = createLogger('LOUD-DUMP');
        lg.setHomey(homey);
        lg.info('Heard: "secret words"', 'STT');
        lg.warn('slow', { api_key: 'sk-1234567890abcdef', host: '192.168.0.10' });
        lg.error('boom', new Error('kaput'));

        const [a, b, c] = logBuffer.snapshot();
        expect([a.level, b.level, c.level]).toEqual(['info', 'warn', 'error']);
        expect(a.text).toBe('Heard: "<12 chars redacted>"');
        expect(b.text).toContain("api_key: 'sk-1....cdef'");
        expect(b.text).toContain("host: '192.168.0.10'");
        expect(c.text).toMatch(/^boom \| Error: kaput/);
    });
});

describe('writeLogDump', () => {
    let dir: string;
    const originalEnv = process.env.HE_LOG_DIR;

    beforeEach(async () => {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'log-dump-'));
        process.env.HE_LOG_DIR = dir;
        logBuffer.clear();
    });
    afterEach(async () => {
        if (originalEnv === undefined) delete process.env.HE_LOG_DIR; else process.env.HE_LOG_DIR = originalEnv;
        await fs.rm(dir, { recursive: true, force: true });
    });

    function fakeHomey() {
        const timers: { fn: () => void; ms: number }[] = [];
        return {
            manifest: { id: 'no.arvebjoe.ai-voice-assistant', version: '1.5.0' },
            version: '12.9.0',
            platform: 'local',
            platformVersion: 2,
            clock: { getTimezone: () => 'UTC' },
            setTimeout: (fn: () => void, ms: number) => { timers.push({ fn, ms }); return 1; },
            timers,
        } as any;
    }

    it('names the file after the Homey-local datetime', () => {
        expect(dumpFilename(Date.UTC(2026, 7, 27, 21, 3, 11), 'UTC')).toBe('2026-08-27_21-03-11.txt');
    });

    it('writes header + lines, returns the URL, and schedules deletion after the TTL', async () => {
        const homey = fakeHomey();
        const lg = createLogger('DUMP-T', true);
        lg.setHomey({ log: vi.fn(), error: vi.fn() } as any);
        lg.info('hello 192.168.0.42');
        lg.info('Heard: "private"', 'STT');

        const now = Date.UTC(2026, 7, 27, 21, 3, 11);
        const res = await writeLogDump(homey, (f) => `http://192.168.0.5/app/x/userdata/log/${f}`, now);

        expect(res.filename).toBe('2026-08-27_21-03-11.txt');
        expect(res.url).toBe('http://192.168.0.5/app/x/userdata/log/2026-08-27_21-03-11.txt');
        expect(res.lines).toBe(2);
        expect(res.expiresAt).toBe(now + DUMP_TTL_MS);

        const onDisk = await fs.readFile(path.join(dir, res.filename), 'utf8');
        expect(onDisk).toBe(res.text);
        expect(onDisk).toContain('App:          no.arvebjoe.ai-voice-assistant 1.5.0');
        expect(onDisk).toContain('Homey:        12.9.0 (local 2)');
        expect(onDisk).toContain('openai_api_key = ');
        expect(onDisk).toContain('DBG [DUMP-T] hello 192.168.0.42');
        expect(onDisk).toContain('DBG [DUMP-T][STT] Heard: "<7 chars redacted>"');
        expect(onDisk).not.toContain('private');

        expect(homey.timers).toHaveLength(1);
        expect(homey.timers[0].ms).toBe(DUMP_TTL_MS);
        homey.timers[0].fn();
        await new Promise((r) => setTimeout(r, 20));
        await expect(fs.access(path.join(dir, res.filename))).rejects.toThrow();
    });

    it('does not overwrite a dump written in the same second', async () => {
        const homey = fakeHomey();
        const now = Date.UTC(2026, 7, 27, 21, 3, 11, 777);
        const first = await writeLogDump(homey, (f) => f, now);
        const second = await writeLogDump(homey, (f) => f, now);
        expect(first.filename).toBe('2026-08-27_21-03-11.txt');
        expect(second.filename).toBe('2026-08-27_21-03-11-777.txt');
    });

    it('initLogDumpFolder empties the folder', async () => {
        await fs.writeFile(path.join(dir, 'old.txt'), 'x');
        await initLogDumpFolder();
        expect(await fs.readdir(dir)).toEqual([]);
    });
});
