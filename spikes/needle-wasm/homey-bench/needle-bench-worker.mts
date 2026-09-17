/**
 * TEMPORARY (spike measurement, see spikes/needle-wasm/README.md).
 * Worker thread that runs the Needle 2 WASM engine on the Homey itself.
 * Delete together with needle-bench.mts once the numbers are in.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const OUT_CAPACITY = 65536;

// Guarded: the Homey app sandbox denies process.memoryUsage().
const rss = (): number | undefined => {
    try {
        return process.memoryUsage().rss;
    } catch {
        return undefined;
    }
};
const dir = workerData.engineDir as string;

// The Emscripten glue is CommonJS and normally locates needle.wasm next to
// itself. The assets live in /userdata, outside the app bundle, so the binary
// is handed over directly and the glue is evaluated by hand if require() is
// not allowed to reach outside the app directory.
function loadGlue(): (opts: Record<string, unknown>) => Promise<any> {
    const path = join(dir, 'needle.cjs');
    try {
        return createRequire(import.meta.url)(path);
    } catch {
        const code = readFileSync(path, 'utf8');
        const module = { exports: {} as any };
        // eslint-disable-next-line no-new-func
        new Function('module', 'exports', 'require', '__dirname', '__filename', code)(
            module, module.exports, createRequire(import.meta.url), dir, path,
        );
        return module.exports as any;
    }
}

const t0 = performance.now();
const createNeedle = loadGlue();
const M = await createNeedle({ wasmBinary: readFileSync(join(dir, 'needle.wasm')) });
const cact = readFileSync(join(dir, 'needle2.cact'));
const weightsPtr = M._malloc(cact.length);
M.HEAPU8.set(cact, weightsPtr);
const loadRc = M.ccall('needle_load', 'number', ['number', 'number'], [weightsPtr, BigInt(cact.length)]);
const outPtr = M._malloc(OUT_CAPACITY);

parentPort!.postMessage({ ready: loadRc >= 0, loadRc, ms: performance.now() - t0, rss: rss() });

parentPort!.on('message', ({ id, op, ...args }: any) => {
    const start = performance.now();
    try {
        if (op === 'init') {
            const rc = M.ccall('needle_init', 'number', ['string', 'string', 'number'], [args.system, args.tools, 0]);
            if (rc < 0) throw new Error(`needle_init failed (code ${rc})`);
            parentPort!.postMessage({ id, ok: true, prefixTokens: rc, ms: performance.now() - start });
        } else if (op === 'complete') {
            M._needle_reset();
            const rc = M.ccall('needle_complete', 'number', ['string', 'number', 'number', 'number'],
                [args.text, 256, outPtr, OUT_CAPACITY]);
            const raw = M.UTF8ToString(outPtr);
            if (rc < 0) throw new Error(raw || `needle_complete failed (code ${rc})`);
            parentPort!.postMessage({ id, ok: true, envelope: JSON.parse(raw), ms: performance.now() - start, rss: rss() });
        }
    } catch (err: any) {
        parentPort!.postMessage({ id, ok: false, error: String(err?.message ?? err) });
    }
});
