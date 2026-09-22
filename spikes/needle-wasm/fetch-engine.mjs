// Downloads the Needle 2 WebAssembly engine + weights from Hugging Face into
// ./engine (gitignored). Run once: `node spikes/needle-wasm/fetch-engine.mjs`.
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `node fetch-engine.mjs [needle2|needle3]` — needle2 lands in ./engine (the
// original spike), any other model in ./engine-<model>.
const MODEL = process.argv[2] ?? 'needle2';
const REPO = `https://huggingface.co/Cactus-Compute/${MODEL}/resolve/main`;
const ENGINE_DIR = join(dirname(fileURLToPath(import.meta.url)), MODEL === 'needle2' ? 'engine' : `engine-${MODEL}`);

// needle.js is CommonJS; the repo is "type": "module", so it must be .cjs.
const FILES = [
    ['wasm/needle.js', 'needle.cjs'],
    ['wasm/needle.wasm', 'needle.wasm'],
    [`${MODEL}.cact`, `${MODEL}.cact`],
    ['config.json', 'config.json'],
];

await mkdir(ENGINE_DIR, { recursive: true });
for (const [remote, local] of FILES) {
    const target = join(ENGINE_DIR, local);
    if (await stat(target).then(() => true, () => false)) {
        console.log(`skip  ${local} (already present)`);
        continue;
    }
    const res = await fetch(`${REPO}/${remote}`);
    if (!res.ok) throw new Error(`${remote}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(target, bytes);
    console.log(`fetch ${local} (${(bytes.length / 1024).toFixed(0)} kB)`);
}
