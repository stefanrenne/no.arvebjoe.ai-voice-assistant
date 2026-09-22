# Spike: Needle 2 (WASM) as a fast path in front of the LLM

**Question:** can [Needle 2](https://github.com/cactus-compute/needle) (45M params, 14 MB, tool calling only) run inside this Node app and safely execute simple smart-home commands without an LLM round trip?

Standalone — nothing under `src/` is touched. Excluded from `tsc` and from the Homey package (`.homeyignore`).

## Run

```bash
node spikes/needle-wasm/fetch-engine.mjs   # once: needle.cjs + needle.wasm + needle2.cact (~14 MB) into ./engine (gitignored)
node spikes/needle-wasm/run.mjs            # all 12 languages, 5 tools, threshold 0.7, guards on
node spikes/needle-wasm/run.mjs --lang nl --threshold 0.9 --no-guards
node spikes/needle-wasm/run.mjs --tools all   # 7 tools -> retrieval engages (slow, see below)
```

## Files

| File | Role |
| --- | --- |
| `needle-worker.mjs` | `worker_thread` owning the Emscripten module: `needle_load` → `needle_init` → `needle_reset` + `needle_complete` per turn |
| `needle-engine.mjs` | Promise wrapper + `decide()` — the execute/fallback contract |
| `guards.mjs` | Deterministic checks on top of the engine's confidence/validation |
| `homey-tools.mjs` | Flat, one-call tools whose zone/device enums come from a Homey snapshot |
| `cases.mjs` | 17 acceptance cases × 12 languages (da de en es fr it ko nl no pl ru sv), zone names in that language |
| `run.mjs` | Runs cases, prints per-case outcome, threshold sweep with and without guards, latency, RSS |

## How the engine is driven

The WASM build exposes the same four C functions as the native library the Python package loads with ctypes (`needle.h`). Gotchas:

- `needle.js` is CommonJS — saved as `needle.cjs` and loaded with `createRequire` (the repo is `"type": "module"`).
- `needle_load(ptr, n)`: `n` is `unsigned long long` → must be passed as a **BigInt**. The weights allocation must never be freed.
- `needle_complete` writes a JSON envelope: `type`, `success`, `function_calls[]`, `reasoning`, **`confidence`**, `validation.{ungrounded,negation}`, `prefill_tps`, `decode_tps`. Confidence and validation are computed **inside the engine**, not in Python — so option A has the full gating contract.
- The system turn takes **facts** (`locale: nl-NL; device: …`), not instructions; the model ignores instructions there. Locale facts made no measurable difference.

## Results (M-series Mac, Node 24, 2026-09-16)

### Latency

| Tools | Per turn | Init |
| --- | --- | --- |
| 1 | ~180 ms | ~0.8 s |
| 5 | ~250 ms (simple) / p50 525 ms / p95 1.9 s | ~2.3–2.9 s |
| 6–7 | **~2.8 s** | ~2.1 s |

**Keep the fast-path tool set at ≤ 5.** Above five, the retrieval head engages and every turn re-selects a top-5 subset, re-prefills it and rebuilds the grammar. `tool_index_path` only caches the init-time tool embeddings and does not remove that per-turn cost. Out-of-range requests ("45 degrees") are the slowest at ~1.9 s — the grammar fights the model until it gives up, and they fall back anyway.

Engine load ~30–70 ms; RSS growth ~20–120 MB. Latency is language-independent; Korean and Russian cost more tokens per turn but stay in the same range. Init must be re-run whenever zones/devices change (~2.4 s, off the main thread).

### Accuracy — all 12 app languages (5 tools, 15 in-scope cases each, 180 turns)

Outcomes: **hit** = executed correctly, **pass** = correctly fell back, **miss** = fell back on a valid command (costs an LLM round trip), **WRONG** = executed the wrong thing.

| All languages | hit | pass | miss | WRONG |
| --- | --- | --- | --- | --- |
| threshold 0.7, engine gate only | 55 | 42 | 17 | **66** |
| threshold 0.95, engine gate only | 41 | 59 | 45 | **35** |
| threshold 0.7, **+ guards** | 51 | 77 | 41 | **11** |
| threshold 0.95, + guards | 37 | 78 | 55 | **10** |

Raising the threshold buys little once the guards are in place: the remaining wrong calls come back at 0.82–1.00 confidence, so the threshold mainly trades coverage away.

Per language at threshold 0.7 with guards (coverage = of 8 in-scope commands, fallbacks = of 7 cases that must not act):

| | coverage | correct fallbacks | WRONG | verdict |
| --- | --- | --- | --- | --- |
| en | 6/8 | 7/7 | 0 | ship |
| nl | 6/8 | 7/7 | 0 | ship |
| pl | 6/8 | 7/7 | 0 | ship |
| fr | 7/8 | 6/7 | 1 | borderline |
| de | 5/8 | 6/7 | 1 | borderline |
| it | 5/8 | 6/7 | 1 | borderline |
| es | 5/8 | 6/7 | 2 | borderline |
| sv | 4/8 | 7/7 | 0 | low value |
| da | 3/8 | 6/7 | 1 | low value |
| no | 1/8 | 7/7 | 1 | off |
| ru | 0/8 | 7/7 | 0 | off |
| ko | 3/8 | 5/7 | 4 | off |

Norwegian and Russian are safe but almost never act, so they buy nothing. Korean is the only language that is actively unsafe. Polish scores well even though the guard blocks *ogrodzie* (the stem test does not survive the o/ó alternation in **Ogród**) — that is a miss, not a wrong call, which is the direction we want failures to go.

### What the guards catch, and what they do not

The guards in `guards.mjs` (target not said / question mark / negation word list / single call only) take wrong executions from 66 down to 11. Everything they catch would otherwise have fired at high confidence.

The remaining 11 are failures guards cannot see:

- **"play <genre> in <zone>" becomes lights-on** (6 of the 11: da, de, es, fr, it, ko) at 0.82–0.97. The zone really was said, so the target guard passes. Adding a **`play_music` decoy tool** (in `homey-tools.mjs`, not in `DEFAULT_TOOLS`) absorbs it in es/fr/it/de — those turns drop to 0.34–0.44 confidence and fall back correctly — but not in da/ko, and swapping it in for another tool shifts other outcomes. Try it with:
  `--tools control_lights,switch_device,set_thermostat,add_to_shopping_list,play_music`
- **Inverted or dropped action** ("침실 불 꺼줘" → on at 0.98; "atenúa el salón" → on instead of dim at 1.00).
- **Free-text arguments tokenized wrongly** (no: `items: ["til melk","og egg","på handlelisten"]` at 1.00). Guarding free text would mean re-deriving it from the transcript, which is the LLM's job.

## Conclusions

1. **Option A runs, but does not fit on a Homey.** Pure WASM in a worker needs no Python and no native binaries, and it works on a Mac — but on a Homey Pro the app was killed for exceeding the memory budget. See the result section at the bottom; that is the headline finding of this spike.
2. **Safety comes from guards, not confidence.** Guards cut wrong executions from 66/180 to 11/180; a higher threshold barely moves that number and costs coverage.
3. **This is a per-language feature, not a global one.** 3 of 12 languages are clean (en, nl, pl), 4 are borderline (fr, de, it, es), 5 should stay off (sv and da act too rarely to be worth it; no and ru almost never act; ko is unsafe). An integration needs a hard allow-list, not a setting the user can point at any language.
4. **The fast path covers at most ~75% of simple commands even in the best languages** — the rest fall through to the LLM, which is the safe direction but caps the win.
5. **Latency gain is real but not dramatic on a Mac** (~250–450 ms vs an LLM round trip). The deciding number is inference time **on Homey Pro hardware**, not measured yet.

## Next steps

- [x] ~~Measure on a Homey Pro~~ — done 2026-09-16: **the app crashed, Memory Warning Limit Reached.** See the result section below.
- [ ] Grow the case set for the allow-list languages (≥ 50 each, real transcripts from the "What did I just say?" recordings, including STT errors and missing punctuation). 17 cases per language is enough to rank languages, not to certify one.
- [ ] Decide the decoy-tool question: does a `play_music` slot (or another absorber) beat a plain 5-tool set once the case set is bigger?
- [ ] Only then: design the integration (pre-stage in `local-pipeline-provider.mts`, gated setting, snapshot from `DeviceManager`, re-init on zone change, template replies, execute via `ToolManager` handlers).
- [x] ~~Watch Needle 3~~ — measured 2026-09-22, see the Needle 3 section. The published model is text-only; better accuracy, same speed, 2.5x the memory.

## Measuring on a real Homey — RESULT: the app crashed (2026-09-16)

Ran on a Homey Pro via `homey app run --remote`. The engine loaded, but during the next voice turn Homey killed the app:

```
⚠ The app has crashed.
Memory Warning Limit Reached
```

Homey's app memory budget is per app: a warning past ~150 MB, termination after ~150 MB for ~50 s, immediate termination at 300 MB (the widely quoted 30 MB is a leftover guideline from the 2016–2019 models; big community apps sit at 40–45 MB). With Needle loaded the app reported 96 MB idle, and a voice turn — which allocates audio buffers, FLAC encoding and an LLM session on top — pushed it over the limit.

### Speed on the device: ~8x slower than the Mac

The bench completed three times before the app was killed, with consistent numbers (Homey Pro, Node v22.23.2 arm64):

| | Homey Pro | M-series Mac |
| --- | --- | --- |
| engine load | 232–255 ms | 30–70 ms |
| `needle_init` (5 tools, 377 prefix tokens) | **14.5–16.0 s** | ~2.4 s |
| per turn, p50 | **2.2 s** | 0.45 s |
| per turn, fastest ("set a timer for 10 minutes") | 1.36 s | 0.17 s |
| per turn, worst (out-of-range refusal) | 16.1 s | 1.9 s |
| decode throughput | 13.7–19 tok/s | 130–250 tok/s |

Answers were identical to the Mac run (same calls, same refusals; confidence differed slightly, e.g. 0.69 vs 0.86 on the Dutch case), so this is purely a throughput story.

**This disqualifies the fast path on its own, before the memory problem.** At 2.2 s median it is slower than the cloud LLM round trip it was meant to replace, the 16 s refusal path would leave the user waiting in silence, and every zone or device change costs a 15 s re-init during which the fast path is unavailable.

Where the memory goes (measured on the Mac, `--expose-gc`):

| Stage | WASM heap | process RSS |
| --- | --- | --- |
| module instantiated | 16.1 MB | 45.8 MB |
| after `needle_load` | 31.6 MB | 99.0 MB |
| after `needle_init` (5 tools) | **45.9 MB** | 145.0 MB |
| after 20 turns | 45.9 MB | 128.7 MB |

The good news: **nothing leaks** — the heap is flat across turns. The bad news: the floor is ~46 MB of WASM heap that exists for as long as the engine is loaded, plus the worker thread's own V8 isolate, on top of an app that already runs a voice pipeline. That does not fit next to this app inside one Homey app budget.

Mitigations considered and rejected:

- **Load on demand, terminate after the turn.** Init costs ~2.4 s on a Mac before the first answer, which is more than the LLM round trip the fast path was supposed to save, and the peak (the thing that killed the app) stays.
- **Free the weights copy after `needle_load`.** Worth ~14 MB of the 46, and the engine appears to keep referencing that allocation (the Python binding never frees it). Not enough to matter anyway.

### What this means for the options

Option A (in-process WASM) is **dead on Homey Pro**, for two independent reasons: a 2.2 s median turn is slower than the LLM round trip it was supposed to save, and the ~46 MB resident engine does not fit in one app budget next to a voice pipeline. More RAM would not rescue it — the CPU is the harder wall.

Still open, in order of attractiveness:

1. **Drop the fast path.** With ~75% coverage in only 3 of 12 languages, a 2.2 s turn on the target hardware and a 46 MB footprint, there is no combination left that beats simply calling the LLM. This is now the recommended outcome.
2. **LAN sidecar** — Needle on a machine outside Homey, like the existing Whisper/Piper/Ollama backends. The CPU problem goes away and so does the memory problem, but it needs a second machine to reach a latency win that a local LLM on that same machine would also deliver, with far better quality.
3. **Separate Homey (Python) app** — a companion app gets its own memory budget, but not its own CPU. The 2.2 s stands. Not worth two apps.
4. **Revisit only if the hardware or the model changes** — a Needle build with SIMD/threads enabled (this WASM build gets ~15 tok/s where the Mac gets 130–250), or a native engine that memory-maps the weights. (Needle 3 was measured on 2026-09-22 — see the section below; it is not audio-capable, so it does not replace STT.)

The harness that produced this is kept in `homey-bench/` (`needle-bench.mts` + `needle-bench-worker.mts`, outside `src/` so nothing builds or ships). To run it again: copy both into `src/debug/`, call `runNeedleBench` from `onInit` gated on `Homey.env.NEEDLE_BENCH === '1'` (the module export — `this.homey.env` is undefined there), put `{ "NEEDLE_BENCH": "1" }` in `env.json`, and `homey app run --remote`. Note that `process.memoryUsage()` throws `ENOENT uv_resident_set_memory` inside the app sandbox, so memory has to be read from Homey Developer Tools.

## Needle 3 (2026-09-22)

Same spike, same 180 cases, same guards — only the model changed:

```bash
node spikes/needle-wasm/fetch-engine.mjs needle3   # -> ./engine-needle3 (gitignored)
node spikes/needle-wasm/run.mjs --model needle3
```

**What Needle 3 actually is.** 121M parameters (most of them in the engram lookup, "the arithmetic of a 50M model"), a 35 MB `.cact`, a 1024-token window, and a new `needle_embed()` for sentence embeddings. The published model is **text-only** (`"modalities": ["text"]`, and the WASM `needle_complete` takes no audio). The audio path in the Python package exists, but there is no audio-capable Needle 3 to point it at — earlier notes in this README that suggested Needle 3 could replace STT were wrong. It also ships as a *ladder*: `needle build --layers N` slices any 2–20-layer subnetwork, but only after LoRA fine-tuning and as a 4-bit export, so the shipped calibrated confidence no longer applies.

### Accuracy: clearly better

| All languages, threshold 0.7 | hit | pass | miss | WRONG |
| --- | --- | --- | --- | --- |
| Needle 2, engine gate only | 55 | 42 | 17 | 66 |
| **Needle 3, engine gate only** | 59 | 60 | 22 | **39** |
| Needle 2, + guards | 51 | 77 | 41 | 11 |
| **Needle 3, + guards** | 53 | 79 | 37 | **11** |

The model alone makes 40% fewer wrong calls; with guards the total ties, but the good languages got better and the spread moved:

| | Needle 2 | Needle 3 |
| --- | --- | --- |
| clean (0 wrong, ≥ 6/8 coverage) | en, nl, pl | **en, nl, de, fr, it** |
| en / nl / de / fr coverage | 6 / 6 / 5 / 7 of 8 | **7 / 7 / 7 / 7 of 8** |
| still off | no, ru, ko | no, ru, **da, sv** (worse), ko |

New failure modes in Needle 3, none of them caught by the guards:

- **Out-of-range escapes into another tool** (4 of 11): "set the bedroom to 45 degrees" is refused by the thermostat grammar (max 30), so the model lands on `control_lights(Sovrum, on, brightness_percent: 45)` at 0.97–1.00. It turns a light on in response to a heating request.
- **Parallel commands come back half** (3 of 11): only the second call, so the guard's single-call rule sees one call and lets it through.
- The "play jazz → lights on" problem is mostly gone (only ko remains).

### Speed and memory: no better, and memory is much worse

| Mac, WASM | Needle 2 | Needle 3 |
| --- | --- | --- |
| per turn p50 / p95 | 525 ms / 1.9 s | 531 ms / 1.3 s |
| init (5 tools) | 2.3–2.9 s | 2.1–2.8 s |
| **WASM heap after load** | 31.6 MB | **81.0 MB** |
| **WASM heap peak** | 45.9 MB | **116.8 MB** |

Per-turn compute is the same as Needle 2, so the Homey would land at the same ~2 s per turn. And the heap is 2.5x larger: Needle 2's 46 MB already crashed the app, and 117 MB on its own is close to the whole ~150 MB per-app budget, so Needle 3 in WASM would not even fit in a dedicated companion app.

### Verdict

Needle 3 is a better model and a worse fit for a Homey. It would be the right choice on a LAN sidecar, where memory is free and a faster CPU makes the 0.5 s latency real. The native engine is the one thing that could change the Homey picture: the `.cact` format is designed to be memory-mapped and read in place, so a native build need not copy 35 MB into a heap the way WASM must. That, plus native speed, is still the single open measurement.

## Needle 3 native on a real Homey (2026-09-22)

The WASM route is dead on memory; the native route was the open question. Result: **it runs, it coexists, it is ~1.1 s per turn.**

### Getting a native runner to start

Cactus' `linux-arm64/needle` runner is dynamically linked against glibc and asks for `/lib/ld-linux-aarch64.so.1`. The Homey app container has **no dynamic loader at all** (Node reports glibc 2.36 but no loader exists on any standard path), so `spawn` fails with `ENOENT` on a file that is there. The fix is `homey-bench/static-runner/`: a ~100-line C wrapper around Cactus' `libneedle.a`, **statically linked** (libc, libc++, libc++abi) in an arm64 Docker container. It speaks a line protocol over stdio and memory-maps the `.cact`. `/userdata` allows exec; the shipped binary loses its exec bit, so the bench copies and chmods it.

### Memory: solved

The runner reports `peak_ram_mb` ≈ 92 MB, but it is a **separate process**, and Homey did not count it against the app: with the runner loaded for 90 s, a full voice turn (tool call, LLM reply, TTS) completed and the app stayed up. Needle 2 in WASM, inside the Node process, got the app killed at 46 MB of heap.

### Speed: ~1.1 s per turn at full depth

| engine threads | init | per turn p50 | min | max |
| --- | --- | --- | --- | --- |
| 1 | 8.0 s | 2.38 s | 1.03 s | 2.60 s |
| 2 | 3.8 s | 1.44 s | 0.59 s | 1.51 s |
| 4 | 2.7 s | **1.16 s** | 0.43 s | 1.51 s |
| auto (= 4) | 2.7 s | **1.15 s** | 0.56 s | 1.22 s |
| *Needle 2 WASM, for reference* | *14.5–16 s* | *2.2 s* | *1.36 s* | *16 s* |

- The Homey exposes **4 real cores with no per-app CPU quota**: a fixed CPU loop takes the same time on 1 thread and on 4 concurrent threads (1077 vs 1088 ms). The engine's own thread choice (4) is therefore right, and the `--wrap=sysconf` thread override in the static runner is not needed here — it only matters under a quota, where the engine's spin-waiting workers made it up to 35x slower in Docker.
- **One Homey core is ~4.5x slower than an M2 core** (same loop: ~1050 vs ~260 ms). That, not the sandbox, sets the ceiling. 2 → 4 threads only buys 1.24x.
- Decode 40–66 tok/s, prefill 90–120 tok/s. Every turn also decodes the engine's `reasoning` string before the call; there is no switch for it in the C API.

### Does 1.1 s help?

- **Cloud speech-to-speech (OpenAI Realtime): no, never.** In the logs the realtime model has already executed `set_device_capability` *before the user finished speaking*. Nothing that starts after the transcript can beat that.
- **Custom pipeline with a local LLM: possibly.** An Ollama turn on modest hardware takes 1–5 s, so a ~1 s answer for ~75% of simple commands in the clean languages (en, nl, de, fr, it) is a real, if modest, win.

### The remaining lever: depth

Needle 3 is trained so that every depth from 2 to 20 layers is a usable model, and the engram lookup (most of the parameters) costs almost nothing per token — so compute per token scales roughly with depth. At 8 layers a turn should land around 0.4–0.5 s on this Homey. Unknowns: accuracy at reduced depth without fine-tuning (Cactus says it drops, and recovers when fine-tuned — which in turn removes the calibrated confidence the guards rely on), and how to get depth onto the Homey: Cactus' runner has `--depth`, but the public C API does not, so either a sliced `.cact` from `needle build --layers N` or Cactus' own runner started through a bundled glibc loader.

### Depth measured: no free lunch (2026-09-22)

`run-native.mjs` runs the same 180 cases through Cactus' native runner in an arm64 Linux container. Two findings first:

- **The runner's `--depth` flag does nothing** with the published `needle3.cact`: identical answers and no speed trend at any value from 2 to 20. Depth has to come from a sliced archive, `needle build --layers N` (needs `cactus-needle[train]`, i.e. JAX; builds in ~15 s from the auto-downloaded 230 MB base checkpoint).
- Sliced rungs are exported as **4-bit (W4A8)**, not the published 2-bit: L16 is 51 MB, L12 39 MB, L8 27 MB, L4 15 MB — L16 is *bigger and slower* than the full published model.

Threshold 0.7, guards on, base weights (no fine-tuning), Mac/Docker timing:

| model | hit | pass | miss | **WRONG** | p50 | est. Homey p50 | clean languages |
| --- | --- | --- | --- | --- | --- | --- | --- |
| published (20 layers, 2-bit) | 53 | 78 | 36 | **13** | 165 ms | ~1.15 s (measured) | en, nl, de, fr |
| L16 (4-bit) | 47 | 70 | 36 | **27** | 192 ms | ~1.3 s | en |
| L12 (4-bit) | 54 | 71 | 34 | **21** | 117 ms | ~0.8 s | none |
| L8 (4-bit) | 26 | 80 | 50 | **24** | 71 ms | ~0.5 s | none |
| L4 (4-bit) | 5 | 82 | 84 | **9** | 62 ms | ~0.45 s | none |

(Homey estimate = Mac time × the measured 7x Homey/Mac ratio for the published model.)

Every rung below full depth roughly **doubles the wrong executions** and loses every clean language; L8 halves coverage on top, and L4 barely acts at all (its low WRONG count is just refusing nearly everything). Cactus says the lost accuracy comes back with fine-tuning on the product's tools, but here that is doubly awkward: the zone and device enums are different in every home, so a tune would have to learn the *shape* of the tools rather than their values, and tuned weights lose the calibrated confidence (the engine's own gate) that half the safety story relies on.

**So the published full-depth model at ~1.15 s is the best Needle can do on a Homey Pro.** Speed through depth costs exactly the accuracy that made Needle 3 worth trying.
