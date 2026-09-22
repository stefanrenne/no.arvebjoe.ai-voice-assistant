// Promise wrapper around needle-worker.mjs, plus the fast-path gate.
// This is the shape a `src/llm/fast-path/` module would take in the app.
import { Worker } from 'node:worker_threads';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { guard } from './guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export class NeedleEngine {
    #worker;
    #nextId = 1;
    #pending = new Map();

    /** Starts the worker and loads the weights. Resolves with the load time. */
    static async start(engineDir = join(HERE, 'engine')) {
        const engine = new NeedleEngine();
        engine.#worker = new Worker(join(HERE, 'needle-worker.mjs'), { workerData: { engineDir } });
        const ready = await new Promise((resolve, reject) => {
            engine.#worker.once('message', resolve);
            engine.#worker.once('error', reject);
        });
        if (!ready.ready) throw new Error(`needle_load failed (code ${ready.loadRc})`);
        engine.#worker.on('message', (msg) => {
            const p = engine.#pending.get(msg.id);
            if (!p) return;
            engine.#pending.delete(msg.id);
            msg.ok ? p.resolve(msg) : p.reject(new Error(msg.error));
        });
        engine.loadMs = ready.ms;
        engine.cactName = ready.cactName;
        engine.heapMb = ready.heapMb;
        return engine;
    }

    #call(op, args) {
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject });
            this.#worker.postMessage({ id, op, ...args });
        });
    }

    /** Pins system prompt + tools as the KV prefix. Re-run whenever zones/devices change. */
    init(system, tools) {
        return this.#call('init', { system, tools: JSON.stringify(tools) });
    }

    /** @returns {Promise<{envelope: object, ms: number}>} */
    complete(text) {
        return this.#call('complete', { text });
    }

    stop() {
        return this.#worker.terminate();
    }
}

/**
 * The fast-path contract: act only on a grounded, non-negated call at or above
 * the confidence threshold; anything else goes to the full LLM unchanged.
 * Pass `context` ({ text, lang }) to also apply the deterministic guards.
 * @returns {{ decision: 'execute' | 'fallback', calls: object[], why: string }}
 */
export function decide(envelope, threshold, context = null) {
    const calls = envelope.function_calls ?? [];
    const validation = envelope.validation ?? {};
    if (envelope.type !== 'call' || !envelope.success) return { decision: 'fallback', calls, why: `type=${envelope.type} success=${envelope.success}` };
    if (calls.length === 0) return { decision: 'fallback', calls, why: 'no call' };
    if (validation.negation) return { decision: 'fallback', calls, why: 'negation' };
    if (validation.ungrounded?.length) return { decision: 'fallback', calls, why: `ungrounded ${validation.ungrounded.join(',')}` };
    if ((envelope.confidence ?? 0) < threshold) return { decision: 'fallback', calls, why: `confidence ${envelope.confidence} < ${threshold}` };
    const blocked = context && guard(calls, context);
    if (blocked) return { decision: 'fallback', calls, why: blocked };
    return { decision: 'execute', calls, why: 'ok' };
}
