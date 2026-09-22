// Accuracy + speed of Needle 3's NATIVE runner at reduced depth, on the same
// 12-language case set and guards as run.mjs. Cactus' runner is linux/glibc,
// so this runs inside an arm64 Linux container:
//
//   docker run --rm --platform linux/arm64 -v "$PWD":/w -w /w node:22-bookworm \
//     node spikes/needle-wasm/run-native.mjs [--models shipped,L16,L8] [--lang en,nl]
//
// Models: "shipped" = the published 2-bit 20-layer needle3.cact; "L<n>" =
// engine-needle3/ladder/needle3-L<n>.cact, built with `needle build --layers n`
// (4-bit W4A8, base weights, no fine-tuning). The runner's own --depth flag
// has no effect on the shipped archive (same output and speed at every value),
// so depth has to come from a sliced archive.
//
// Needs engine-needle3/needle3.cact (fetch-engine.mjs needle3) and the runner
// at engine-needle3/needle-linux-arm64 (Cactus-Compute/needle3 linux-arm64/needle).
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { decide } from './needle-engine.mjs';
import { DEFAULT_TOOLS, buildTools, systemFacts } from './homey-tools.mjs';
import { LANGUAGES } from './cases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, 'engine-needle3');
const { values: opts } = parseArgs({
    options: {
        models: { type: 'string', default: 'shipped,L20,L16,L12,L8,L4' },
        lang: { type: 'string', default: Object.keys(LANGUAGES).join(',') },
        threshold: { type: 'string', default: '0.7' },
    },
});
const threshold = Number(opts.threshold);
const toolFilter = new Set(DEFAULT_TOOLS);

// Scoring identical to run.mjs.
const norm = (calls) => calls
    .map((c) => JSON.stringify({ name: c.name, arguments: Object.fromEntries(
        Object.entries(c.arguments ?? {})
            .filter(([, v]) => v !== null && v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : v])) }))
    .sort();
const sameCalls = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
function outcome(row, thr, guarded) {
    const { decision, calls } = decide(row.envelope, thr, guarded ? { text: row.q, lang: row.lang } : null);
    if (decision === 'fallback') return row.calls.length ? 'miss' : 'pass';
    return sameCalls(calls, row.calls) ? 'hit' : 'wrong';
}
const pct = (xs, p) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];

const waitForPort = (port, child) => new Promise((resolve, reject) => {
    const deadline = Date.now() + 60_000;
    const attempt = () => {
        if (child.exitCode !== null) return reject(new Error(`runner exited ${child.exitCode}`));
        const s = connect(port, '127.0.0.1');
        s.once('connect', () => { s.destroy(); resolve(); });
        s.once('error', () => { s.destroy(); Date.now() > deadline ? reject(new Error('timeout')) : setTimeout(attempt, 100); });
    };
    attempt();
});
const post = async (port, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
};

const work = mkdtempSync(join(tmpdir(), 'needle-native-'));
let port = 19000;
const results = [];
const modelPath = (m) => (m === 'shipped' ? join(ENGINE, 'needle3.cact') : join(ENGINE, 'ladder', `needle3-${m}.cact`));
for (const depth of opts.models.split(',')) {
    const rows = [];
    const inits = [];
    for (const lang of opts.lang.split(',')) {
        const { home, cases: all } = LANGUAGES[lang];
        const tools = buildTools(home).filter((t) => toolFilter.has(t.name));
        const names = new Set(tools.map((t) => t.name));
        const cases = all.filter((c) => c.calls.every((f) => names.has(f.name)));
        const toolsPath = join(work, `tools-${lang}.json`);
        const systemPath = join(work, `system-${lang}.txt`);
        writeFileSync(toolsPath, JSON.stringify(tools));
        writeFileSync(systemPath, systemFacts(lang));
        const p = port++;
        const started = Date.now();
        const child = spawn(join(ENGINE, 'needle-linux-arm64'), [
            '--model', modelPath(depth), '--tools', toolsPath, '--system', systemPath,
            '--serve', '--port', String(p),
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d; });
        try {
            await waitForPort(p, child);
        } catch (err) {
            console.log(`depth ${depth} ${lang}: runner failed: ${err.message} ${stderr.slice(0, 300)}`);
            child.kill();
            continue;
        }
        inits.push(Date.now() - started);
        for (const c of cases) {
            await post(p, '/reset', {}).catch(() => undefined);
            const t0 = performance.now();
            const envelope = await post(p, '/complete', { input: c.q });
            rows.push({ depth, lang, ...c, envelope, ms: performance.now() - t0 });
        }
        child.kill();
    }
    const count = (thr, guarded) => {
        const n = { hit: 0, pass: 0, miss: 0, wrong: 0 };
        for (const r of rows) n[outcome(r, thr, guarded)]++;
        return n;
    };
    const perLang = {};
    for (const r of rows) {
        const o = outcome(r, threshold, true);
        perLang[r.lang] ??= { hit: 0, positives: 0, wrong: 0 };
        if (r.calls.length) perLang[r.lang].positives++;
        if (o === 'hit') perLang[r.lang].hit++;
        if (o === 'wrong') perLang[r.lang].wrong++;
    }
    const clean = Object.entries(perLang).filter(([, v]) => v.wrong === 0 && v.hit >= 6).map(([k]) => k);
    const lat = rows.map((r) => r.ms);
    results.push({ depth, raw: count(threshold, false), guarded: count(threshold, true), perLang, clean,
        p50: pct(lat, 0.5), p95: pct(lat, 0.95), init: pct(inits, 0.5), rows });

    const g = results.at(-1);
    console.log(`\n══ ${depth} (threshold ${threshold}) — ${rows.length} turns, p50 ${g.p50.toFixed(0)} ms, p95 ${g.p95.toFixed(0)} ms, init ~${g.init} ms`);
    console.log(`   engine gate only: hit ${g.raw.hit}  pass ${g.raw.pass}  miss ${g.raw.miss}  WRONG ${g.raw.wrong}`);
    console.log(`   + guards:         hit ${g.guarded.hit}  pass ${g.guarded.pass}  miss ${g.guarded.miss}  WRONG ${g.guarded.wrong}`);
    console.log(`   per language (coverage/8, wrong): ${Object.entries(perLang).map(([k, v]) => `${k} ${v.hit}/${v.positives}${v.wrong ? ` ✗${v.wrong}` : ''}`).join('  ')}`);
    console.log(`   clean languages (0 wrong, ≥6/8): ${clean.join(', ') || 'none'}`);
    const wrongs = rows.filter((r) => outcome(r, threshold, true) === 'wrong');
    for (const r of wrongs) {
        const got = (r.envelope.function_calls ?? []).map((f) => `${f.name}(${JSON.stringify(f.arguments)})`).join(' + ');
        console.log(`   ✗ [${r.lang}/${r.cat}] ${r.envelope.confidence?.toFixed?.(2)} "${r.q}" -> ${got}`);
    }
}

console.log('\n══ summary');
console.log('model    hit  pass  miss  WRONG   p50 ms  clean languages');
for (const g of results) {
    console.log(`${String(g.depth).padEnd(7)} ${String(g.guarded.hit).padStart(4)} ${String(g.guarded.pass).padStart(5)} ${String(g.guarded.miss).padStart(5)} ${String(g.guarded.wrong).padStart(6)}  ${g.p50.toFixed(0).padStart(7)}  ${g.clean.join(', ')}`);
}
