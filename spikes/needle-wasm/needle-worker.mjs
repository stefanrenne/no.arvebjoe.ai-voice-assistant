// worker_thread that owns the WASM engine. Inference is synchronous CPU work,
// and in the app the event loop is shared with the ESP TCP client and audio
// streaming, so the engine must never run on the main thread.
//
// Protocol (request -> reply, one at a time):
//   { id, op: 'init', system, tools }   -> { id, ok, prefixTokens, ms }
//   { id, op: 'complete', text }         -> { id, ok, envelope, ms }
import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const OUT_CAPACITY = 65536;

const loadStart = performance.now();
const createNeedle = require(join(workerData.engineDir, 'needle.cjs'));
const M = await createNeedle();
const cact = readFileSync(join(workerData.engineDir, 'needle2.cact'));
// Weights are handed over as a pointer and stay referenced by the engine:
// never free this allocation.
const weightsPtr = M._malloc(cact.length);
M.HEAPU8.set(cact, weightsPtr);
const loadRc = M.ccall('needle_load', 'number', ['number', 'number'], [weightsPtr, BigInt(cact.length)]);
const outPtr = M._malloc(OUT_CAPACITY);

parentPort.postMessage({ ready: loadRc >= 0, loadRc, ms: performance.now() - loadStart });

parentPort.on('message', ({ id, op, ...args }) => {
    const t0 = performance.now();
    try {
        if (op === 'init') {
            // 0 = no tool_index_path (retrieval index file); fine for a small tool set.
            const rc = M.ccall('needle_init', 'number', ['string', 'string', 'number'], [args.system, args.tools, 0]);
            if (rc < 0) throw new Error(`needle_init failed (code ${rc})`);
            parentPort.postMessage({ id, ok: true, prefixTokens: rc, ms: performance.now() - t0 });
        } else if (op === 'complete') {
            // Every voice turn is independent for the fast path: no carried context.
            M._needle_reset();
            const rc = M.ccall('needle_complete', 'number', ['string', 'number', 'number', 'number'],
                [args.text, args.maxNewTokens ?? 256, outPtr, OUT_CAPACITY]);
            const raw = M.UTF8ToString(outPtr);
            if (rc < 0) throw new Error(raw || `needle_complete failed (code ${rc})`);
            parentPort.postMessage({ id, ok: true, envelope: JSON.parse(raw), ms: performance.now() - t0 });
        } else {
            throw new Error(`unknown op ${op}`);
        }
    } catch (err) {
        parentPort.postMessage({ id, ok: false, error: String(err?.message ?? err), ms: performance.now() - t0 });
    }
});
