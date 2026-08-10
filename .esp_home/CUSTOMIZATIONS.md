# Voice PE config customizations

These are the local changes applied on top of the **stock `home-assistant-voice.yaml`** downloaded
from ESPHome / GitHub. When you download a fresh config (an update wipes these), re-apply the changes
below to get back to the customized behavior.

All line numbers are approximate — search for the anchor text instead.

## Base version

`home-assistant-voice.yaml` is based on **`esphome/home-assistant-voice-pe` `dev` @ commit
[`7c6eb245`](https://github.com/esphome/home-assistant-voice-pe/commit/7c6eb245b1d5253ee8672fbbdb604767e59a8ee9)**
(2026-06-18, *"Bump min version to 2026.6.0"* #601) — `dev` a couple of commits after release tag
**26.6.0** (`772f2b9`, which is an ancestor of the base). Downloaded 2026-06-22.

The stock config carries **no version marker of its own** (upstream's plain `home-assistant-voice.yaml`
has no `project:` block), so record the commit here whenever the stock file is refreshed. To re-derive
it after the fact, diff the local file against candidate upstream revisions — the base is the one where
the only differences left are the changes documented below:

```bash
curl -sfL -o /tmp/up.yaml \
  https://raw.githubusercontent.com/esphome/home-assistant-voice-pe/<sha-or-tag>/home-assistant-voice.yaml
diff -u /tmp/up.yaml home-assistant-voice.yaml
```

Indirect markers that corroborate the base: `min_version: 2026.6.0`, XMOS `voice_kit` firmware
`v1.3.1`, and `external_components` pinned to `ref: dev` (so component *code* floats to whatever `dev`
is at build time, regardless of this file's age).

**Known upstream drift** (as of 2026-08-10, upstream `dev` HEAD `0579e7b`): a single commit touches
this YAML since the base — **#428 "Switch to lock buttons"** (2026-07-08), which adds a
`disable_buttons` template switch (*Disable physical controls*, `disabled_by_default: true`) and gates
the center/volume button handlers on it. Purely additive; not applied here.

---

## Change 1 — Custom "Hey Homey" wake word

> ⚠️ **USE microWakeWord, NOT openWakeWord.** These are two different systems with near-identical names:
> - **microWakeWord** ([microwakeword.com](https://microwakeword.com/)) — runs **on the ESP32 itself**. This is
>   what the Voice PE uses. ← train here.
> - **openWakeWord** ([openwakeword.com](https://openwakeword.com/)) — runs on a **server** (HA add-on). Its
>   `.tflite` uses ops (e.g. `SHAPE`) the on-device engine can't run. It tests fine online but **crash-loops
>   the PE**. There is no openWakeWord server in the Homey-app setup, so its models are unusable here and are
>   **not convertible** to microWakeWord. (This exact mix-up caused the first boot loop.)
>
> ⚠️ **MODEL COMPATIBILITY — read this before enabling.** The `.tflite` must be a proper
> **streaming microWakeWord V2** export. ESPHome's on-device engine registers only a small fixed set
> of TFLite-Micro ops. If the model contains an unsupported op (e.g. `SHAPE`), the device does **not**
> error at compile — it flashes fine, then **crash-loops at boot**:
> ```
> Failed to get registration from op code SHAPE
> Guru Meditation Error: Core 0 panic'ed (LoadProhibited)
> Rebooting...
> ```
> The crash happens at model *load* (right after `STARTING -> DETECTING_WAKE_WORD`), so no
> `probability_cutoff` change helps. Recovery: comment out the model entry and re-flash over USB
> (or wait ~10 fast reboots for safe mode, then OTA). A bad export is also often suspiciously large
> (the first failed `hey_homey.tflite` was 824 KB; stock streaming models are far smaller).
> **Build the model with a trainer that targets ESPHome specifically** (microwakeword.com "firmware-ready"
> output, or the TaterTotterson Docker trainer) and verify it boots before relying on it. The model
> entry is currently **commented out** in `home-assistant-voice.yaml` for this reason.


The trained model lives in this folder under `wake_words/` and is hosted on GitHub:

```
.esp_home/wake_words/hey_homey.json     (manifest, V2 format)
.esp_home/wake_words/hey_homey.tflite   (trained model — add after training)
```

In the **`micro_wake_word:`** block, find the `models:` list and add `hey_homey` as the first entry:

```yaml
micro_wake_word:
  id: mww
  ...
  models:
    - model: https://raw.githubusercontent.com/arvebjoe/no.arvebjoe.ai-voice-assistant/main/.esp_home/wake_words/hey_homey.json
      id: hey_homey
    - model: https://github.com/kahrendt/microWakeWord/releases/download/okay_nabu_20241226.3/okay_nabu.json
      id: okay_nabu
    # ... leave the rest (hey_jarvis, hey_mycroft, stop) unchanged
```

> **Use the direct `raw.githubusercontent.com` URL, NOT the `github.com/.../raw/main/...` form.**
> The `github.com/.../raw/` URL returns a 302 redirect that ESPHome's model downloader rejects at
> validation time with a misleading *"Not a valid model name, local path, http(s) url, or github
> shorthand"* error. The `raw.githubusercontent.com` form serves the file directly (no redirect).
> The github shorthand `github://arvebjoe/no.arvebjoe.ai-voice-assistant/.esp_home/wake_words/hey_homey.json@main`
> also works as an alternative.
>
> Both `hey_homey.json` and `hey_homey.tflite` must be pushed to the `main` branch for the compile-time
> download to work (swap `main`→`master` in the URL if that's the default branch). The manifest's
> `"model": "hey_homey.tflite"` is relative, so the two files must sit in the same folder.

### Training the model (microwakeword.com)

> ⚠️ **USE MULTIPLE TTS VOICES — a single-voice training set tanks recall.** The first `hey_homey`
> attempt was trained on **Norwegian, which offers only one Piper voice**, and scored **5% recall**
> (it woke ~1 in 20 times — unusable). A single voice gives the trainer no acoustic variety, so the
> model overfits to that one speaker's timbre/prosody and fails to generalize to a real human voice.
> **Voice diversity is the single biggest lever for wake-word recall.**
>
> Fix: train on **English (US), which has ~10 Piper voices**, and spell the wake word so the English
> voices pronounce it the way you actually say it — e.g. **"Hey Homey"** (the Norwegian "Hei Homey"
> is a near-homophone, so English voices match your real pronunciation while giving 10× the variety).

**Recommended training settings** (microwakeword.com, benchmark-validated for ESP32-S3):

| Setting                  | Value            | Notes |
|--------------------------|------------------|-------|
| Voice composition        | English (US), all voices | Multiple voices is the whole point — see warning above. |
| Number of samples        | 40,000           | Recommended sweet spot. |
| Augmentation rounds      | 2                | Adds room acoustics / background noise variation. |
| Adversarial samples      | 0                | The tool itself notes adversarials **suppress recall** — leave off. |
| Training steps           | 12,000           | Recommended. |
| Negative Class Weight    | 10–20            | This is the "Penalty" column on the results screen. In theory: lower = more recall + more false accepts, higher = stricter (range 10 → 2000). **In practice the two runs below didn't follow that rule** (see note), so don't treat it as a precise dial — pick something in the 10–20 range and judge by results. |
| Learning rate            | 0.001 (default)  | Leave. |

If a Manual run still lands low, switch the training mode to **Optuna Optimization** to auto-search
hyperparameters instead of guessing.

### Observed runs (Hey Homey, English US)

| Run    | Penalty | Steps  | FA/H | Recall (synthetic) |
|--------|---------|--------|------|--------------------|
| Jun 22 | 20      | 12,000 | 1.9  | 5.0%               |
| Jun 27 | 10      | 12,000 | 0.4  | 2.6%               |

> ⚠️ **Don't over-read these two runs.** Going from penalty 20 → 10 gave *fewer* false accepts (1.9 →
> 0.4) **and** lower reported recall (5.0% → 2.6%) — the opposite of the "lower penalty = more recall +
> more false accepts" theory on *both* axes. Two single runs can't establish a trend; this is almost
> certainly run-to-run training variance, not the penalty doing something. If you care which penalty
> is better, run each value a few times and compare, don't trust one run.

### What "good" actually looks like — trust real voice, not the synthetic number

The recall percentages the site reports (single digits, above) are measured against **synthetic TTS
voices**, and they have been suspiciously low across every run — well below the ~80% you'd normally
want from a wake word. Either the site's synthetic-recall metric is stricter / measured differently
than plain "how often it wakes," or these models genuinely under-detect. **We don't fully understand
the metric yet, so the source of truth is real-world behaviour:**

1. **Use the "Test" button with your own voice** on the model before flashing — say "Hey Homey" 10–20
   times and count how often it wakes. That hit rate matters more than the displayed recall number.
2. Then **flash it and live with it for a day.** Does it wake when you want and stay quiet otherwise?
3. Prefer a **low FA/H** (green on the results screen) — a wake word that fires randomly is more
   annoying than one you occasionally have to repeat.

Training is cheap (~200 credits per run), so iterate. If real-world use is poor, come back to this and
revisit the metric / settings rather than chasing the synthetic recall figure.

### Tuning sensitivity without retraining — `probability_cutoff`

The `micro.probability_cutoff` value in `hey_homey.json` is the **per-model sensitivity knob**, and you
can change it and re-flash **without any new training run**. It's the confidence score (0–1) the model
must clear before it wakes:

- **Higher (e.g. `0.98`)** = stricter → wakes less easily, almost never false-fires.
- **Lower (e.g. `0.95` or below)** = more lenient → wakes more readily, more false wakes.

This single setting explains most of the gap between the two runs above — the Jun 27 manifest ships
`0.98` vs the Jun 22 manifest's `0.95`, so a big part of the "lower recall" is just the stricter
threshold, not a worse model. **If Hey Homey is too deaf in real use, lower this toward 0.95 and below
before assuming the model is bad.** (Current shipped value: **`0.98`**.)

> ⚠️ **The device's "wake word sensitivity" selector does NOT affect Hey Homey.** That select's lambda
> (in `home-assistant-voice.yaml`) only calls `set_probability_cutoff` on `okay_nabu`, `hey_jarvis`,
> and `hey_mycroft`. For Hey Homey the manifest's `probability_cutoff` is the only sensitivity control —
> to make the UI selector affect it too, you'd have to add `hey_homey` to that lambda.

> **Remember:** the device downloads the model from `raw.githubusercontent.com/.../main/...` at compile
> time, **not** from your local folder — so any manifest edit only takes effect after it's committed and
> pushed to `main` and the device is re-flashed.

---

## Change 2 — Shared rainbow palette + dot-position globals

All four rainbow voice-phase effects (Waiting / Listening / Thinking / Reply) draw the **same thing**:
a single lit LED walking the ring, colored from a **256-entry rainbow palette built once at boot**.
The effects differ only in how that dot moves — slow, fast, stopped, or backwards.

Three globals carry it:

- `led_rainbow_lut` — the palette, `Color[256]`, hue 0–255 at full saturation/value. Built once so no
  effect does HSV math per frame and all four are guaranteed to use an identical palette.
- `led_dot_pos` — which LED (0–11) the dot is on.
- `led_color_index` — where in the palette its color comes from.

Position and color are **global, not per-effect `static`s**: that is what makes a phase change
seamless. The dot never jumps or restarts — it keeps its exact LED and color, and only the movement
changes.

In the **`globals:`** section, add these entries (next to `global_led_animation_index` is fine):

```yaml
  - id: led_rainbow_lut
    type: Color[256]
    restore_value: no
  - id: led_dot_pos
    type: uint8_t
    restore_value: no
    initial_value: '0'
  - id: led_color_index
    type: uint8_t
    restore_value: no
    initial_value: '0'
```

> `uint8_t` for `led_color_index` matters: it wraps 255→0 by itself, so `+= 3` never needs a modulo
> and the palette walk is seamless. `Color[256]` is a legitimate global type — ESPHome's
> `GlobalsComponent` handles array types explicitly (`std::remove_extent`).

Fill the palette in the **`esphome:` → `on_boot:`** block, **before** `script.execute: control_leds`:

```yaml
  on_boot:
    priority: 375
    then:
      # Build the shared rainbow palette once, before anything can draw with it.
      - lambda: |-
          for (uint16_t h = 0; h < 256; h++) {
            id(led_rainbow_lut)[h] = ESPHSVColor((uint8_t) h, 255, 255).to_rgb();
          }
      - script.execute: control_leds
```

> The loop counter is `uint16_t` on purpose — a `uint8_t h` would wrap to 0 at 256 and loop forever.

---

## Change 3 — Custom LED ring effects

In the **`light:`** section, under the `voice_assistant_leds` partition light's `effects:` list, add the
effects below. Insert them anywhere in the list — next to the existing `"Replying"` / `"Muted or Silent"`
effects is fine.

All four draw the **same comet** — a lit dot plus two dimmed LEDs trailing behind it — and then move
it and advance the color. They differ only in `update_interval`, in `dir`, and in the two step values.
Copy them from the `effects:` list in this repo's `home-assistant-voice.yaml` (search for the effect
names). The body every one of them shares:

```yaml
            const int8_t dir = 1;   // direction of travel; the trail sits behind it
            Color c = id(led_rainbow_lut)[id(led_color_index)];
            for (uint8_t i = 0; i < 12; i++) {
              if (i == id(led_dot_pos)) {
                it[i] = c;
              } else if (i == (id(led_dot_pos) + 12 - dir) % 12) {
                it[i] = c * 96;
              } else if (i == (id(led_dot_pos) + 12 - 2 * dir) % 12) {
                it[i] = c * 32;
              } else {
                it[i] = Color::BLACK;
              }
            }
```

> The `+ 12 -` keeps the index non-negative before the `%`, for **both** values of `dir`: with
> `dir = -1` the two trail terms evaluate to `pos + 1` and `pos + 2`, i.e. the trail flips to the
> other side of the dot so it still follows rather than leads.

| Effect             | Phase     | Interval | Dot movement                | `dir` | Behavior |
|--------------------|-----------|----------|-----------------------------|-------|----------|
| `Waiting Rainbow`  | Waiting   | 100ms    | `+1` → 1.2s/lap             | `1`   | Slow walk around the ring. |
| `Voice Rainbow`    | Listening | 50ms     | `+1` → 0.6s/lap             | `1`   | Same walk, twice as fast. |
| `Thinking Rainbow` | Thinking  | 50ms     | **none** (`led_dot_pos` untouched) | `1` | The comet stops dead; only its color keeps cycling the palette in place. `dir` stays `1` so the frozen trail keeps pointing back the way Listening came. |
| `Reply Rainbow`    | Replying  | 50ms     | `+11 % 12` → −1, 0.6s/lap   | `-1`  | Listening speed, running backwards, trail flipped to follow. |

The color step is `+6` at 100ms and `+3` at 50ms — deliberately the same hue rate in wall-clock time,
so the palette walk takes ~4.3s per full cycle in **every** phase and only the movement distinguishes
them. Because position and color live in globals, each phase picks the dot up exactly where the
previous one left it: no jump, no restart, one continuous animation across the whole conversation.

> The older **Cold Rainbow** / **Warm Rainbow** (hue-band rings) and **Thinking White** effects, and
> the earlier full-ring rotating-rainbow + fade-to-white design that used `led_rainbow_rotation` /
> `led_white_level`, were all superseded by this one and removed from the YAML. The full-ring version
> still exists in `home-assistant-voice-debug.yaml` if you want it back.

### Tuning knobs
- **Speed:** `update_interval` (how often the dot steps) — 100ms Waiting, 50ms the rest. The ring's
  `max_refresh_rate` is 15ms, so don't go below ~16ms.
- **Direction:** `+ 1` vs `+ 11` in the `id(led_dot_pos) = ... % 12` line — and flip that effect's
  `dir` to match, or the trail ends up leading the dot. Swap both if the comet runs the wrong way on
  your unit (CW/CCW depends on the physical wiring).
- **Color cycle speed:** the `id(led_color_index) += N` step. Keep the 2:1 ratio between the 100ms and
  50ms effects to keep the hue rate constant across phases; raise both to cycle faster.
- **Trail length / falloff:** the `c * 96` and `c * 32` scales (out of 255 ≈ 38% and 12%). Raise them
  for a longer-looking smear, lower for a crisper dot; add a third `else if` at `- 3 * dir` with a
  smaller scale for one more tail LED. All 12 LEDs lit means no visible motion, so keep it short.
- **Palette:** the `on_boot` fill (Change 2). Narrow the hue range or drop saturation there and every
  effect follows, since they all index the one array.

---

## Change 4 — Point the voice phases at the effects

In the **`script:`** section, set the `effect:` line inside the four `control_leds_*` phase scripts.
The stock config uses the effect names in the "Stock" column; change them to the "Custom" column.

| Script id                                                  | Stock effect              | → Custom effect      |
|------------------------------------------------------------|---------------------------|----------------------|
| `control_leds_voice_assistant_waiting_for_command_phase`   | `"Waiting for Command"`   | `"Waiting Rainbow"`  |
| `control_leds_voice_assistant_listening_for_command_phase` | `"Listening For Command"` | `"Voice Rainbow"`    |
| `control_leds_voice_assistant_thinking_phase`              | `"Thinking"`              | `"Thinking Rainbow"` |
| `control_leds_voice_assistant_replying_phase`              | `"Replying"`              | `"Reply Rainbow"`    |

Each edit is just the one `effect:` line, e.g.:

```yaml
  - id: control_leds_voice_assistant_thinking_phase
    then:
      - light.turn_on:
          brightness: !lambda return max( id(led_ring).current_values.get_brightness() , 0.2f );
          id: voice_assistant_leds
          effect: "Thinking Rainbow"      # was: "Thinking"
```

> The stock effects (`Waiting for Command`, `Listening For Command`, `Thinking`, `Replying`) can be
> left defined in the `effects:` list — they just become unused, which makes reverting easy.

### Resulting behavior
One comet — a lit dot with a two-LED trail, colored from the shared palette — is the whole conversation:
- **Waiting** → it walks the ring slowly (1.2s/lap)
- **Listening** → the same walk at double speed (0.6s/lap)
- **Thinking** (processing) → it stops where it is and cycles colors in place
- **Replying** (speaking the answer) → it moves again at Listening speed, **backwards**
- back to **Waiting** → it just slows down again

The color keeps cycling at the same rate throughout, and position/color are globals, so nothing ever
resets at a phase boundary — the transitions are seamless while each phase reads differently.

Error / muted / timer states are left untouched (error = red pulse, etc.).

### Debug phase colors (kept as inert extras; full debug config in `home-assistant-voice-debug.yaml`)

For diagnosing the conversation flow, four **solid-color debug effects** remain defined in the
`effects:` list (right after `Reply Rainbow`), and `home-assistant-voice-debug.yaml` is a full copy
of the config with the phase scripts pointed at them — flash that file when phase transitions need
to be unambiguous at a glance:

| Phase script                                               | Debug effect        | Color            |
|------------------------------------------------------------|---------------------|------------------|
| `control_leds_voice_assistant_waiting_for_command_phase`   | `"Debug Waiting"`   | solid **amber**  |
| `control_leds_voice_assistant_listening_for_command_phase` | `"Debug Listening"` | solid **green**  |
| `control_leds_voice_assistant_thinking_phase`              | `"Debug Thinking"`  | solid **blue**   |
| `control_leds_voice_assistant_replying_phase`              | `"Debug Replying"`  | solid **red**    |

Amber = mic open but no speech detected yet (`on_listening`), green = the PE's on-device VAD hears
speech (`on_stt_vad_start`), blue = intent/LLM working (`on_stt_vad_end`), red = TTS playback.
Amber→green *before the user speaks* on a follow-up turn = the TTS echo tripped the local VAD.
Note: solid red is *steady*; the Error effect is a fast red *pulse*, so they remain distinguishable.

**To switch the main config to debug colors** without flashing the debug file: point the four
`effect:` lines at the `Debug *` names above; revert by setting them back to the "Custom" column of
the Change 4 table.

---

## Change 5 — Mic gain for command capture (auto gain) — currently `6 dbfs`

> ⚠️ **Currently `6 dbfs` — a deliberate compromise. Do NOT return to `15`.** History:
> - `15 dbfs` (commit c6ee5a0) over-amplified close/normal speech and **clipped it**, adding audible
>   distortion to the STT recording — which hurt recognition more than low volume did.
> - `0 dbfs` (stock, AGC off) sounded clean, but left the **start of each recording quiet**: the PE's
>   **XMOS XU316 hardware AGC** (in the `ffva` XMOS firmware, separate from this software knob and not
>   controllable from YAML) has an attack ramp that was previously masked by the software boost.
> - `6 dbfs` lifts the overall level enough to soften that quiet start **without clipping**.
>
> If quiet/distant speech is still too low, nudge to `9 dbfs` and re-check the `input_buffer_debug`
> recording for clipping first. Never jump back to `15`.

In the **`voice_assistant:`** block:

```yaml
voice_assistant:
  ...
  noise_suppression_level: 0
  auto_gain: 6 dbfs        # compromise: lift level without clipping. NOT 15 (clipped), NOT 0 (quiet start under XMOS AGC ramp).
  volume_multiplier: 1
```

> This is the **software** AGC knob (runs on the ESP32) — distinct from the **XMOS hardware AGC** that
> runs first and causes the start-of-recording volume ramp (baked into the XMOS firmware, no YAML knob).
> Too high clips loud/close speech; prefer fixing genuinely low volume by mic placement first.

### Tuning knobs (same block)
- **`auto_gain`** — `0`–`31 dbfs`. Higher = more amplification of quiet/distant speech, but also
  clips loud/close speech. Currently `6` (compromise after `15` distorted and `0` left a quiet start) —
  if you raise it, go gradually (`6`→`9`) and verify no clipping in the debug recording; never `15`.
- **`volume_multiplier`** — flat multiplier on mic samples (default `1`). Cruder than AGC and also
  boosts noise. Avoid stacking a large multiplier on top of high `auto_gain` — they clip together
  and *hurt* recognition.
- **`noise_suppression_level`** — `0`–`4`. Raise to ~`2` only if the problem is background noise
  rather than low volume; too high eats quiet speech.

---

## After re-applying

```
ESPHome → Install   # compiles the YAML, downloads the wake-word model, flashes the device
```
