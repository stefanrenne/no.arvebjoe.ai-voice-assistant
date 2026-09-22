/**
 * TEMPORARY (spike measurement, see spikes/needle-wasm/README.md).
 *
 * Runs Needle 3 NATIVELY on the Homey through a statically linked runner
 * (src/debug/bin/needle-line, built from Cactus' libneedle.a — source in
 * spikes/needle-wasm/homey-bench/static-runner/). Static because the Homey
 * app container has no glibc loader: Cactus' own dynamically linked runner
 * fails there with spawn ENOENT.
 *
 * Enable in env.json (gitignored), then `homey app run --remote`:
 *     { "NEEDLE_BENCH": "1" }
 * Optional:
 *     "NEEDLE_BENCH_THREADS": "1,2,4,0"  engine thread counts to try, in order;
 *                                        0 = the engine's own choice (default "1,2,4,0")
 *     "NEEDLE_BENCH_KEEP": "0"           seconds to keep the last runner loaded so a
 *                                        voice turn can test coexistence (default 0)
 *
 * Thread count matters enormously: the engine sizes its pool from
 * hardware_concurrency() and its workers spin-wait, so under a CPU quota
 * smaller than the core count it is up to 25x slower than one thread
 * (calibrated in Docker with --cpus; see spikes/needle-wasm/README.md).
 *
 * Delete src/debug/ and the app.mts hook once the numbers are in.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { chmod, copyFile, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { join } from 'node:path';

type Log = (line: string) => void;

export interface NativeBenchOptions {
    engineDir?: string;
    keepSeconds?: number;
    threads?: number[];
}

const REPO = 'https://huggingface.co/Cactus-Compute/needle3/resolve/main';

/** Bump to re-arm the bench after a crash (see the crash-loop guard). */
const BENCH_VERSION = 5;

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

// Same 10 queries as the Needle 2 WASM run on this Homey, so the numbers compare directly.
// A subset of the Needle 2 WASM run's queries, so the numbers compare directly.
// Kept short: each runner should live well under Homey's ~50 s over-budget window.
const QUERIES = [
    'turn on the kitchen lights',
    'switch off the lights in the bedroom',
    'set the bathroom to 22 degrees',
    'set a timer for 10 minutes',
    'add milk and eggs to the shopping list',
    'what will the weather be tomorrow',
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function probeEnvironment(log: Log): void {
    const cpus = os.cpus();
    let glibc = 'unknown';
    try {
        glibc = (process.report?.getReport() as any)?.header?.glibcVersionRuntime ?? 'none reported';
    } catch {
        glibc = 'report unavailable';
    }
    log(`[needle3] ${process.platform}/${process.arch}, node ${process.version}, ${cpus.length} cpu(s) `
        + `"${cpus[0]?.model ?? '?'}", total mem ${(os.totalmem() / 1048576).toFixed(0)} MB, free ${(os.freemem() / 1048576).toFixed(0)} MB`);
    log(`[needle3] libc: glibc runtime ${glibc}; `
        + `ld-linux-aarch64 ${existsSync('/lib/ld-linux-aarch64.so.1') ? 'present' : 'MISSING'}, `
        + `ld-musl ${existsSync('/lib/ld-musl-aarch64.so.1') ? 'present' : 'absent'}, tmpdir ${os.tmpdir()}`);
}

async function ensureAssets(dir: string, log: Log): Promise<void> {
    await mkdir(dir, { recursive: true });
    const target = join(dir, 'needle3.cact');
    if (!(await stat(target).then(() => true, () => false))) {
        const started = Date.now();
        const res = await fetch(`${REPO}/needle3.cact`);
        if (!res.ok || !res.body) throw new Error(`needle3.cact: HTTP ${res.status}`);
        // Streamed: buffering 35 MB in one piece helped get the app killed before.
        await pipeline(Readable.fromWeb(res.body as any), createWriteStream(`${target}.part`));
        await copyFile(`${target}.part`, target);
        await rm(`${target}.part`, { force: true });
        log(`[needle3] downloaded needle3.cact in ${Date.now() - started} ms`);
    }
    await writeFile(join(dir, 'tools.json'), JSON.stringify(TOOLS));
    await writeFile(join(dir, 'system.txt'), SYSTEM);
}

/** Line-oriented client for needle-line's stdio protocol. */
class LineRunner {
    private waiters: Array<(line: string) => void> = [];
    private constructor(readonly child: ChildProcess, readonly bin: string) {
        createInterface({ input: child.stdout! }).on('line', (line) => {
            const next = this.waiters.shift();
            if (next) next(line);
        });
    }

    /**
     * The shipped binary may have lost its exec bit, and /userdata may be
     * mounted noexec, so try a chmod'ed copy in /userdata, then /tmp, then
     * the shipped file itself.
     */
    static async start(dir: string, threads: number, log: Log): Promise<LineRunner> {
        const shipped = fileURLToPath(new URL('./bin/needle-line', import.meta.url));
        const args = [join(dir, 'needle3.cact'), join(dir, 'tools.json'), join(dir, 'system.txt'), String(threads)];
        for (const bin of [join(dir, 'needle-line'), join(os.tmpdir(), 'needle-line'), shipped]) {
            try {
                if (bin !== shipped) await copyFile(shipped, bin);
                await chmod(bin, 0o755);
            } catch (err: any) {
                log(`[needle3] cannot stage ${bin}: ${err?.message ?? err}`);
                continue;
            }
            const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
            const failed = await new Promise<Error | null>((resolve) => {
                child.once('spawn', () => resolve(null));
                child.once('error', (err) => resolve(err));
            });
            if (failed) {
                log(`[needle3] cannot start ${bin}: ${failed.message}`);
                continue;
            }
            child.stderr!.on('data', (d: Buffer) => log(`[needle3][stderr] ${d.toString().trim()}`));
            child.once('exit', (code, signal) => log(`[needle3] runner exited (code ${code}, signal ${signal})`));
            log(`[needle3] started ${bin} (pid ${child.pid}), threads ${threads || 'auto'}`);
            return new LineRunner(child, bin);
        }
        throw new Error('the static runner could not be started from any location');
    }

    next(timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no reply within ${timeoutMs} ms`)), timeoutMs);
            this.waiters.push((line) => { clearTimeout(timer); resolve(line); });
        });
    }

    send(line: string): void {
        this.child.stdin!.write(`${line.replace(/[\r\n]+/g, ' ')}\n`);
    }

    stop(): void {
        this.child.stdin!.end();
        this.child.kill('SIGTERM');
    }
}

async function benchThreads(dir: string, threads: number, keep: number, log: Log): Promise<void> {
    const label = threads || 'auto';
    const wall = Date.now();
    const runner = await LineRunner.start(dir, threads, log);
    try {
        let ready = await runner.next(180_000);
        while (ready.startsWith('DIAG ')) {
            log(`[needle3] diag ${ready.slice(5)}`);
            ready = await runner.next(180_000);
        }
        if (!ready.startsWith('READY ')) throw new Error(`runner did not start: ${ready}`);
        const r = JSON.parse(ready.slice(6));
        log(`[needle3] t=${label}: ready in ${Date.now() - wall} ms wall (load ${r.load_ms} ms, init ${r.init_ms} ms)`);

        const times: number[] = [];
        let peakRam = 0;
        for (const query of QUERIES) {
            const started = Date.now();
            runner.send(query);
            const line = await runner.next(60_000);
            const wallMs = Date.now() - started;
            if (!line.startsWith('OK ')) {
                log(`[needle3] t=${label} ${wallMs} ms  "${query}" -> ${line}`);
                continue;
            }
            const space = line.indexOf(' ', 3);
            const engineMs = Number(line.slice(3, space));
            const env = JSON.parse(line.slice(space + 1));
            times.push(engineMs);
            peakRam = Math.max(peakRam, Number(env.peak_ram_mb) || 0);
            const fmt = (calls: any[] = []) => calls.map((f) => `${f.name}(${JSON.stringify(f.arguments)})`).join(' + ');
            log(`[needle3] t=${label} ${engineMs.toFixed(0).padStart(5)} ms  conf ${Number(env.confidence).toFixed(2)}  `
                + `prefill ${env.prefill_tps} / decode ${env.decode_tps} tps  "${query}" -> ${fmt(env.function_calls) || '—'}`);
        }
        const sorted = [...times].sort((a, b) => a - b);
        if (sorted.length) {
            log(`[needle3] t=${label} SUMMARY: p50 ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms, `
                + `min ${sorted[0].toFixed(0)} ms, max ${sorted[sorted.length - 1].toFixed(0)} ms, init ${r.init_ms} ms, peak_ram ${peakRam} MB`);
        }
        if (keep > 0) {
            log(`[needle3] runner stays loaded ${keep} s — SAY A COMMAND TO A SATELLITE NOW to test coexistence`);
            await sleep(keep * 1000);
            log('[needle3] coexistence window over, app still alive');
        }
    } finally {
        runner.stop();
    }
}

export async function runNeedle3NativeBench(log: Log, options: NativeBenchOptions = {}): Promise<void> {
    const dir = options.engineDir ?? '/userdata/needle3';
    await mkdir(dir, { recursive: true });

    // Crash-loop guard: a marker that survives a crash means the previous run
    // never reached the end, so do not try again (Homey restarts crashed apps).
    // Versioned so a fixed build is not blocked by an older build's marker.
    for (const old of ['.bench-running', '.bench-running-v2']) await rm(join(dir, old), { force: true });
    const marker = join(dir, `.bench-running-v${BENCH_VERSION}`);
    if (existsSync(marker)) {
        log('[needle3] previous bench run did not finish — the app most likely crashed during it. '
            + 'Not running again; bump BENCH_VERSION in needle3-native-bench.mts (or reinstall the app) to retry.');
        return;
    }
    await writeFile(marker, new Date().toISOString());

    probeEnvironment(log);
    await ensureAssets(dir, log);

    const threadCounts = options.threads?.length ? options.threads : [1, 2, 4, 0];
    const keep = options.keepSeconds ?? 0;
    for (const [index, threads] of threadCounts.entries()) {
        await benchThreads(dir, threads, index === threadCounts.length - 1 ? keep : 0, log);
        // Let the app's memory settle so back-to-back runners do not add up to
        // one long stretch over budget.
        if (index < threadCounts.length - 1) await sleep(15_000);
    }
    await rm(marker, { force: true });
    log('[needle3] done — compare with the Needle 2 WASM run in spikes/needle-wasm/README.md');
}
