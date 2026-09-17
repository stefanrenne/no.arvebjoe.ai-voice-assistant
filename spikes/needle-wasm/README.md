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
- [ ] Watch Needle 3: it accepts audio input (`needle_complete` with a `needle_audio` struct), which could run the fast path before or instead of STT.

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
4. **Revisit only if the hardware or the model changes** — a Needle build with SIMD/threads enabled (this WASM build gets ~15 tok/s where the Mac gets 130–250), or Needle 3 replacing STT instead of adding a stage before it.

The harness that produced this is kept in `homey-bench/` (`needle-bench.mts` + `needle-bench-worker.mts`, outside `src/` so nothing builds or ships). To run it again: copy both into `src/debug/`, call `runNeedleBench` from `onInit` gated on `Homey.env.NEEDLE_BENCH === '1'` (the module export — `this.homey.env` is undefined there), put `{ "NEEDLE_BENCH": "1" }` in `env.json`, and `homey app run --remote`. Note that `process.memoryUsage()` throws `ENOENT uv_resident_set_memory` inside the app sandbox, so memory has to be read from Homey Developer Tools.
