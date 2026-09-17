// Runs the fast-path acceptance cases against the WASM engine and reports
// accuracy, the confidence-threshold trade-off and latency.
//
//   node spikes/needle-wasm/run.mjs [--lang en,nl,no] [--threshold 0.7]
//                                   [--tools all|name,name] [--no-facts] [--no-guards] [--quiet]
//
// The number that matters is WRONG: a call the fast path would have executed
// that differs from the expected one. A miss only costs an LLM round trip; a
// wrong execution switches off the wrong light.
import { parseArgs } from 'node:util';
import { NeedleEngine, decide } from './needle-engine.mjs';
import { DEFAULT_TOOLS, buildTools, systemFacts } from './homey-tools.mjs';
import { LANGUAGES } from './cases.mjs';

const { values: opts } = parseArgs({
    options: {
        lang: { type: 'string', default: Object.keys(LANGUAGES).join(',') },
        threshold: { type: 'string', default: '0.7' },
        // Comma-separated tool names, or "all". More than 5 engages retrieval (slow).
        tools: { type: 'string', default: DEFAULT_TOOLS.join(',') },
        'no-facts': { type: 'boolean', default: false },
        // Per-case output and the per-language summary use guards unless disabled.
        'no-guards': { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
    },
});
const threshold = Number(opts.threshold);
const toolFilter = opts.tools === 'all' ? null : new Set(opts.tools.split(','));
const SWEEP = [0, 0.3, 0.5, 0.7, 0.8, 0.9, 0.95];

// Drop null/absent optionals and compare order-insensitively; string compare is
// case-insensitive for free-text fields (shopping items), enums come back exact.
const norm = (calls) => calls
    .map((c) => JSON.stringify({ name: c.name, arguments: Object.fromEntries(
        Object.entries(c.arguments ?? {})
            .filter(([, v]) => v !== null && v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : v])) }))
    .sort();
const sameCalls = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));

/** hit | wrong | miss | pass (correct fallback) */
function outcome(row, thr, guarded) {
    const { envelope, calls: expected } = row;
    const { decision, calls } = decide(envelope, thr, guarded ? { text: row.q, lang: row.lang } : null);
    if (decision === 'fallback') return expected.length ? 'miss' : 'pass';
    return sameCalls(calls, expected) ? 'hit' : 'wrong';
}

const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];
const MARK = { hit: '✓ hit  ', pass: '✓ pass ', miss: '· miss ', wrong: '✗ WRONG' };

const rssBefore = process.memoryUsage().rss;
const engine = await NeedleEngine.start();
console.log(`engine loaded in ${engine.loadMs.toFixed(0)} ms (worker thread)\n`);

const all = [];
for (const lang of opts.lang.split(',')) {
    const { home, cases: allCases } = LANGUAGES[lang];
    const tools = buildTools(home).filter((t) => !toolFilter || toolFilter.has(t.name));
    const names = new Set(tools.map((t) => t.name));
    // A positive case for a tool that is not loaded is out of scope for this run.
    const cases = allCases.filter((c) => c.calls.every((f) => names.has(f.name)));
    const init = await engine.init(opts['no-facts'] ? '' : systemFacts(lang), tools);
    console.log(`── ${lang}: ${tools.length} tools, ${cases.length} cases, init ${init.ms.toFixed(0)} ms, ${init.prefixTokens} prefix tokens`);
    for (const c of cases) {
        const { envelope, ms } = await engine.complete(c.q);
        const row = { lang, ...c, envelope, ms };
        all.push(row);
        if (opts.quiet) continue;
        const o = outcome(row, threshold, !opts['no-guards']);
        const conf = envelope.confidence?.toFixed(2) ?? ' -- ';
        const got = (envelope.function_calls ?? []).map((f) => `${f.name}(${JSON.stringify(f.arguments)})`).join(' + ') || '—';
        console.log(`${MARK[o]} ${conf} ${ms.toFixed(0).padStart(4)}ms [${c.cat}] ${c.q}\n            got: ${got}` +
            (o === 'wrong' || o === 'miss' ? `\n           want: ${c.calls.map((f) => `${f.name}(${JSON.stringify(f.arguments)})`).join(' + ') || '—'}  (${decide(envelope, threshold, opts['no-guards'] ? null : { text: c.q, lang }).why})` : ''));
    }
    console.log();
}

// Guards are pure post-processing, so both sweeps come from the same inference.
for (const guarded of [false, true]) {
    console.log(`── threshold sweep, all languages, guards ${guarded ? 'ON' : 'OFF'}`);
    console.log('threshold   hit  pass  miss  WRONG');
    for (const thr of SWEEP) {
        const n = { hit: 0, pass: 0, miss: 0, wrong: 0 };
        for (const r of all) n[outcome(r, thr, guarded)]++;
        console.log(`${String(thr).padEnd(9)} ${String(n.hit).padStart(5)} ${String(n.pass).padStart(5)} ${String(n.miss).padStart(5)} ${String(n.wrong).padStart(6)}${thr === threshold ? '  ← --threshold' : ''}`);
    }
    console.log();
}

console.log('── per language at --threshold', threshold, opts['no-guards'] ? '(guards OFF)' : '(guards ON)');
for (const lang of new Set(all.map((r) => r.lang))) {
    const rows = all.filter((r) => r.lang === lang);
    const n = { hit: 0, pass: 0, miss: 0, wrong: 0 };
    for (const r of rows) n[outcome(r, threshold, !opts['no-guards'])]++;
    const positives = rows.filter((r) => r.calls.length).length;
    console.log(`${lang}: fast-path coverage ${n.hit}/${positives}, correct fallbacks ${n.pass}/${rows.length - positives}, WRONG ${n.wrong}`);
}

const lat = all.map((r) => r.ms);
console.log(`\n── latency per turn: p50 ${pct(lat, 0.5).toFixed(0)} ms, p95 ${pct(lat, 0.95).toFixed(0)} ms, max ${Math.max(...lat).toFixed(0)} ms`);
console.log(`── RSS growth: ${((process.memoryUsage().rss - rssBefore) / 1048576).toFixed(0)} MB`);
await engine.stop();
