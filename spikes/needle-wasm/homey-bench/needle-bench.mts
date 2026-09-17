/**
 * TEMPORARY (spike measurement, see spikes/needle-wasm/README.md).
 *
 * Answers the one question the Mac cannot: how fast is Needle 2 on Homey
 * hardware, and does the app sandbox allow a worker thread + WASM at all?
 *
 * Enable by putting this in env.json (gitignored), then `homey app run --remote`:
 *     { "NEEDLE_BENCH": "1" }
 *
 * Engine assets (~14 MB) are downloaded once into /userdata/needle/.
 * Delete this file, needle-bench-worker.mts and the app.mts hook afterwards.
 */
import { Worker } from 'node:worker_threads';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const ENGINE_DIR = '/userdata/needle';
const REPO = 'https://huggingface.co/Cactus-Compute/needle2/resolve/main';
const ASSETS: Array<[string, string]> = [
    ['wasm/needle.js', 'needle.cjs'],
    ['wasm/needle.wasm', 'needle.wasm'],
    ['needle2.cact', 'needle2.cact'],
];

const SYSTEM = 'locale: en-GB; device: smart speaker';

const TOOLS = [
    {
        name: 'control_lights',
        description: 'Turn the lights in one stated zone on or off, or dim them to a stated percentage.',
        parameters: {
            type: 'object',
            properties: {
                zone: { type: 'string', enum: ['Living room', 'Kitchen', 'Bedroom', 'Study', 'Garden'] },
                action: { type: 'string', enum: ['on', 'off', 'dim'] },
                brightness_percent: { type: 'integer', minimum: 1, maximum: 100 },
            },
            required: ['zone', 'action'],
        },
    },
    {
        name: 'switch_device',
        description: 'Turn one named device on or off.',
        parameters: {
            type: 'object',
            properties: {
                device: { type: 'string', enum: ['Christmas tree', 'Coffee machine', 'Dehumidifier'] },
                action: { type: 'string', enum: ['on', 'off'] },
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
                zone: { type: 'string', enum: ['Living room', 'Bedroom', 'Bathroom'] },
                temperature: { type: 'number', minimum: 5, maximum: 30 },
            },
            required: ['zone', 'temperature'],
        },
    },
    {
        name: 'set_timer',
        description: 'Start a countdown timer for a stated duration.',
        parameters: { type: 'object', properties: { minutes: { type: 'integer', minimum: 0, maximum: 600 } } },
    },
    {
        name: 'add_to_shopping_list',
        description: 'Add one or more stated items to the shopping list.',
        parameters: {
            type: 'object',
            properties: { items: { type: 'array', items: { type: 'string' }, minItems: 1 } },
            required: ['items'],
        },
    },
];

// Latency is language-independent (measured on the Mac), so the on-device run
// only needs a representative mix: simple, argument-heavy, and a refusal.
const QUERIES = [
    'turn on the kitchen lights',
    'switch off the lights in the bedroom',
    'set the bathroom to 22 degrees',
    'set a timer for 10 minutes',
    'add milk and eggs to the shopping list',
    'turn on the christmas tree',
    'doe het licht in de keuken aan',
    'zet een timer van 10 minuten',
    'what will the weather be tomorrow',
    'set the bedroom to 45 degrees',
];

async function ensureAssets(log: (line: string) => void): Promise<void> {
    await mkdir(ENGINE_DIR, { recursive: true });
    for (const [remote, local] of ASSETS) {
        const target = join(ENGINE_DIR, local);
        if (await stat(target).then(() => true, () => false)) continue;
        const started = Date.now();
        const res = await fetch(`${REPO}/${remote}`);
        if (!res.ok) throw new Error(`${remote}: HTTP ${res.status}`);
        const bytes = Buffer.from(await res.arrayBuffer());
        await writeFile(target, bytes);
        log(`[needle-bench] downloaded ${local} (${(bytes.length / 1024).toFixed(0)} kB) in ${Date.now() - started} ms`);
    }
}

/**
 * RSS is not readable inside the Homey app sandbox — process.memoryUsage()
 * throws ENOENT on uv_resident_set_memory — so memory has to be read from
 * Homey Developer Tools (Apps -> memory) instead of from here.
 */
function rss(): string {
    try {
        return `${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`;
    } catch {
        return 'n/a';
    }
}

export async function runNeedleBench(log: (line: string) => void): Promise<void> {
    const mb = (bytes: number | undefined) => (typeof bytes === 'number' ? `${(bytes / 1048576).toFixed(0)} MB` : 'n/a');
    log(`[needle-bench] node ${process.version} ${process.arch}, app RSS ${rss()}`);
    await ensureAssets(log);

    const worker = new Worker(new URL('./needle-bench-worker.mjs', import.meta.url), {
        workerData: { engineDir: ENGINE_DIR },
    });
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
    let nextId = 1;
    const ready = await new Promise<any>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
    });
    if (!ready.ready) throw new Error(`needle_load failed (code ${ready.loadRc})`);
    log(`[needle-bench] engine loaded in ${ready.ms.toFixed(0)} ms, worker RSS ${mb(ready.rss)}`);
    worker.on('message', (msg: any) => {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
    });
    const call = (op: string, args: Record<string, unknown>) => new Promise<any>((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        worker.postMessage({ id, op, ...args });
    });

    try {
        const init = await call('init', { system: SYSTEM, tools: JSON.stringify(TOOLS) });
        log(`[needle-bench] init ${init.ms.toFixed(0)} ms (${TOOLS.length} tools, ${init.prefixTokens} prefix tokens)`);

        const times: number[] = [];
        for (const query of QUERIES) {
            const { envelope, ms, rss } = await call('complete', { text: query });
            times.push(ms);
            const calls = (envelope.function_calls ?? [])
                .map((f: any) => `${f.name}(${JSON.stringify(f.arguments)})`).join(' + ') || '—';
            log(`[needle-bench] ${ms.toFixed(0).padStart(5)} ms  conf ${envelope.confidence?.toFixed(2)}  `
                + `decode ${envelope.decode_tps} tps  worker RSS ${mb(rss)}  "${query}" -> ${calls}`);
        }
        const sorted = [...times].sort((a, b) => a - b);
        log(`[needle-bench] per turn: p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms, `
            + `max ${sorted[sorted.length - 1].toFixed(0)} ms, app RSS ${rss()}`);
        log('[needle-bench] done — compare with the Mac numbers in spikes/needle-wasm/README.md');
    } finally {
        await worker.terminate();
    }
}
