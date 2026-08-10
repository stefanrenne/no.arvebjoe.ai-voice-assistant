# TODO — single source of truth

## Audio URLs can advertise the container's Docker address (all drivers)

- [ ] **`getLanIP()` can return the app container's Docker-bridge address, making every reply
      URL unreachable from the satellite.** Found in the ReSpeaker tester's log 2026-08-10
      (forum post #60) — the device tried to fetch
      `http://172.17.0.2/app/no.arvebjoe.ai-voice-assistant/userdata/audio/tx_….flac` and got
      `esp-tls: [sock=58] select() timeout` → `ESP_ERR_HTTP_CONNECT`. `172.17.0.0/16` is
      Docker's default bridge; a later run of the same device on the same app used
      `192.168.1.107` and played fine, so this is **intermittent, not device-specific, and
      affects every driver**.

      Cause is `webserver.mts:69-79`: the loop returns on the **first** non-internal IPv4
      whose interface name matches `/^(eth|en|enx)/i`. Inside the app container the Docker
      veth is `eth0`, so it matches and short-circuits before the real LAN interface is ever
      considered. Which interface enumerates first is a startup race — hence the intermittency.
      (The tester self-diagnosed it as "related to using a custom pipeline"; it is not, the
      pipeline switch merely coincided with an app restart that lost the race.)

      Preferred fix: derive the advertised host from the **local address of the TCP socket
      already connected to the ESP device** (`socket.localAddress`) — routable back by
      construction, no heuristics. Keep `getLanIP()` as the fallback for the no-device-connected
      case and teach it to skip `172.16.0.0/12` alongside the existing `169.254.` skip.

      Downstream symptom worth recognising in future reports: an unreachable announce URL puts
      the satellite in a **~2 s retry loop** — the firmware's hardcoded `start_playback_timeout_`
      ends the announce as "finished", our `announce_finished` handler
      (`voice-assistant-device.mts:432`) dequeues the next segment, repeat. On the ReSpeaker
      that surfaces as an endless `Beam lock released` / `activate_stop_word_once is already
      running` churn, which looks like a firmware fault and is not one.

## ESPHome native-API protocol correctness

- [ ] **`stt_end()`, `stt_vad_end()` and `intent_progress()` never transmit their text.** All
      three pass a spread `{ text }` to `vaEvent()`
      (`esp-voice-assistant-client.mts:963`, `:1020`, `:968`), but `VoiceAssistantEventResponse`
      has only `event_type` and repeated `data` (`api.proto:1728-1735`) — protobufjs silently
      drops the unknown key. The device logs `No text in STT_END event`, confirmed in the
      ReSpeaker log 2026-08-10. Convert to the `data: [{name, value}]` form that `intent_end()`
      and `tts_end()` already use; the trap is documented in those two methods' comments and
      these three simply never got converted.
- [ ] **We never subscribe to Home Assistant actions/events.** The client sends
      `SubscribeVoiceAssistantRequest` + `SubscribeStatesRequest` at
      `esp-voice-assistant-client.mts:727-731` but never
      `SubscribeHomeassistantServicesRequest` (id 34, defined at `api.proto:735`, unused). Every
      event a device fires at us is dropped with `client has not subscribed to actions (yet)` —
      on the ReSpeaker that is `esphome.tts_uri`, `esphome.stt_text` and
      `esphome.wake_word_detected`, several per turn. **Nothing is broken by this today** (we
      consume none of them), so it is log-noise reduction plus an opening for a real
      wake-word-detected signal. Must stay off the discovery-probe path like the other
      subscribes.
- [ ] **Consider advertising a newer API version.** We send `apiVersionMajor: 1,
      apiVersionMinor: 6` (`esp-voice-assistant-client.mts:336-337`); current firmware logs
      `'ai-voice-assistant' using outdated API 1.6, update to 1.14+`. Cosmetic today — but check
      what 1.7-1.14 gate before bumping, since the handshake compatibility notes in CLAUDE.md
      depend on the current behaviour.

## Code quality — long-term (not a release gate)

- [ ] **L1 — split oversized classes / reduce `any` at trust boundaries.** The last open item
      from the second code review; context in [`docs/code_review_2.md`](./docs/code_review_2.md)
      (the fixed review items are archived in [`COMPLETED.md`](./COMPLETED.md) §7 and §12).
      Not a release gate — only touch opportunistically when other work already opens those
      files. Centralizing provider lifecycle state was deliberately declined under M7 and
      belongs here if it is ever done.

## Turn robustness — nothing caps how long one utterance may run

- [ ] **Add a maximum-utterance cap to the turn.** `NO_SPEECH_TIMEOUT_MS` (15 s,
      `voice-assistant-device.mts:132`) is the only clock on an open mic, and it is **cleared
      outright** the moment the provider's VAD reports speech (`:753`). After that the sole
      thing that can end the turn is the provider's `silence` event — server VAD has no maximum
      duration — so a mic feed that never goes quiet enough pins the state machine in
      `listening` **forever**. The satellite sits on its listening page and stops answering.
      Found while triaging the M5Stack hang report (2026-08-10); it is not M5Stack-specific,
      but aggressive on-device AGC (`auto_gain: 31dBFS` + `volume_multiplier: 2.0`) pumping
      room noise between words is a plausible trigger.

      The fix is to make `speech` lower the net to a floor rather than cancel it. Mind
      `tests/voice-assistant-device.test.mts` — the case *"stands down once VAD hears speech,
      however long the user then talks"* asserts today's behaviour deliberately and has to be
      rewritten alongside. Users now have a manual escape hatch (switching the tile's *Start
      conversation* off cancels the turn), so this is a robustness item, not an emergency.

## ReSpeaker XVF3800 driver — needs hardware verification

Driver written 2026-07-28 from the community ESPHome config alone (**no hardware was
available**), so everything below is a documented best guess. Research and the reasoning behind
each choice: [`docs/respeaker-xvf3800/README.md`](./docs/respeaker-xvf3800/README.md).

**Tester feedback 2026-08-07 — first real-hardware report.** A tester with a board reports it
"seems to be working". Encouraging but NOT yet a tick for anything below: he confirmed nothing
item by item, so treat these as still open until he answers specifics. His board has **no
speaker**, which is why he cannot verify anything on the playback side at all — he wants the
reply handed to a Sonos speaker as a URL instead (see *Reply audio as a URL for speakerless
devices* under "High value, more work"). Ask him explicitly about mic levels at `mic_gain` 0,
the listed device name, the mute switch, and whether his unit carries an API encryption key.

**Second report 2026-08-10 (forum post #60), with full app + ESPHome logs.** Two of the three
problems he reported are now root-caused and have their own sections above — the `Beam lock
released` loop is the **Docker-bridge audio URL** bug, and the `client has not subscribed to
actions` spam plus `No text in STT_END event` are the **protocol correctness** items. Neither is
ReSpeaker-specific and neither is caused by the custom pipeline he suspected. His config is the
stock [`respeaker-xvf-satellite-example.yaml`](https://github.com/formatBCE/Respeaker-XVF3800-ESPHome-integration/blob/main/config/respeaker-xvf-satellite-example.yaml)
with only the device name changed. What remains open and ReSpeaker-shaped:

- [ ] **Device stops reacting to a follow-up question** (field report 2026-08-10, **root cause
      not established** — do not fix blind). In his 21:10 log the reply plays correctly
      (`Streaming …tx_79e63413….flac (FLAC)`, `Decode finished`), then `micro_wake_word` fires
      **four** times (`21:10:45`, `:47`, `:52`, `:58`) and nothing follows — no new
      `VoiceAssistantRequest`, no STT. So detection works and the device simply never asks us to
      start a run, which points at it being stuck in conversation/announce state instead of
      returning to idle. Corroborating: a doubled `Beam lock released` at `:41.038`/`:41.040`,
      and `micro_wake_word: Wake word detection is already running` in the earlier log. Our side
      of that state is the sticky `continue_conversation` flag on `intent_end(text,
      continueConversation)` (`esp-voice-assistant-client.mts:~990`) — worth auditing what we
      send for this device, but the YAML's `on_end` also does an **unbounded** `wait_until` before
      restarting `micro_wake_word`, exactly like the M5Stack hang candidate above. Needs a
      reproduction or a DEBUG-level device log covering one good turn plus one ignored wake word.
- [ ] **`No text in TTS_START event` — the replying phase never engages on this hardware.**
      We deliberately omit the text on the announce path (`voice-assistant-device.mts:412`)
      because the PE firmware fires `tts_start_trigger_` itself for announcements. The ReSpeaker
      YAML's `on_tts_start` does not, so its LED/beam "replying" phase is skipped. Sending the
      text unconditionally is probably right, but verify it does not double-fire the phase on
      the PE before changing it.
- [ ] **Pair a real device end to end** — mDNS scan, manual IP, and the encrypted (Noise) path.
      Confirm it lists as *"reSpeaker XVF3800 Assistant"* (that name is derived from the YAML,
      not observed).
- [ ] **Confirm the identity sniff fires.** We match on `respeaker` / `xvf3800` in
      HelloResponse/DeviceInfoResponse. If Seeed's own wiki YAML (unreachable during research)
      names the device without either token, widen the match.
- [ ] **Check `voice_assistant_feature_flags`** — VOICE_ASSISTANT | API_AUDIO | TIMERS |
      ANNOUNCE are certain from the config; START_CONVERSATION is assumed, not verified.
- [ ] **Verify mic levels with `mic_gain` at 0 (1×).** The XMOS chip does AGC/AEC/beamforming
      on-chip and the config zeroes the software stages, so it should behave like the PE rather
      than the TR — but if speech is missed, this is the first knob.
- [ ] **Tune `initial_audio_skip` / `followup_audio_skip`** against the wake-word ding; both
      default to 0 and were never measured on this hardware.
- [ ] **Confirm the mute switch is `microphone_mute`.** `scoreMuteCandidate()` picks it and
      deliberately ignores the device's decoy `mute_sound` switch; check `volume_mute` actually
      mutes the mic.
- [ ] **Replace the stand-in artwork.** `drivers/respeaker-xvf3800/assets/` holds a stylised
      top-view rendering of the board (drawn, not photographed — deliberately not a reused photo
      of another device). Swap in real product images before the store release.

## M5Stack AtomS3R driver — needs hardware verification

Driver written 2026-08-06 from M5Stack's official ESPHome config alone (**no hardware was
available**) for [issue #44](https://github.com/arvebjoe/no.arvebjoe.ai-voice-assistant/issues/44);
the reporter owns three units and volunteered to test. Research and reasoning:
[`docs/m5stack-atoms3r/README.md`](./docs/m5stack-atoms3r/README.md).

**First hardware report, 2026-08-07:** the reporter's unit is adopted by Home Assistant and
does carry an encryption key — it listed as *"needs encryption key"*, and the Noise handshake,
entity list and DeviceInfo/VA-config exchange all **succeeded**. It then failed the identity
check with `not_a_match`, because he had renamed the device ("Mikro EG") and the M5Stack
config exposes no other identifying string (no `project:`, no `board:` → `model` is just
`esp32-s3-devkitc-1`). Manual entry now accepts an unidentified-but-voice-capable device; see
[`docs/m5stack-atoms3r/README.md`](./docs/m5stack-atoms3r/README.md#identity-defaults--user-editable).

**Second hardware report, 2026-08-10 — the core loop works.** With `friendly_name` temporarily
set to *"Mikro EG AtomS3R"* (the workaround for the identity miss above, no longer needed once
`3020e3d` ships) the tester confirmed: **pairing completes and the device lists correctly**, the
**wake word → question → spoken reply loop works**, and the **microphone hears him from across
the room** at `mic_gain` 1× — so the no-`defaultMicGain`-override call was right, and the sniff
branch does fire on the `atoms3r` token. No clipping reported on close-up speech either.

What he found broken heads the list below. Note how many of them are **"the command seems not to
arrive"** shaped, and reading M5Stack's YAML against our code found no defect on our side: the
mute switch really is `mute_microphone` (`scoreMuteCandidate()` scores it 1), the vendored
`es8311` component does implement `set_volume`, ESPHome applies volume to the *announcement*
speaker (our playback path) and `volume_min: 0.5`/`volume_max: 0.8` still spans roughly −32 dB
to +6.5 dB at the DAC. **All of it is blocked on the ESPHome device log** — `logger: level: DEBUG`
is already on in the stock config and the tester flashes his own firmware, so one log covering a
mute, a volume change, a timer and a hang settles all four at once. Requested 2026-08-10.

- [ ] **Mute switch does not work** (field report). Wiring looks correct end to end; needs the
      device log to see whether `SwitchCommandRequest` arrives and whether `microphone.mute`
      runs. Cosmetic firmware quirk to expect while reading it: `on_announcement` paints the
      muted page during *any* announcement, so the mic-off icon is not proof of a mute.
- [ ] **Volume does not work** (field report). Same: needs the log to see whether
      `MediaPlayerCommandRequest` arrives. The clamp is not the explanation.
- [ ] **`onoff` appears to do nothing** (field report). It should chime and open the mic
      (announce + `start_conversation`). ESPHome sets ANNOUNCE **and** START_CONVERSATION
      whenever the VA has a `media_player:`, and this config does — so if it genuinely does
      nothing, that is a real bug. The tile is now labelled *"Start conversation"* and off
      cancels the running turn, which removes the "is this a power switch?" confusion but not
      the underlying report.
- [ ] **No timer finish chime** (field report). `on_timer_finished` → `switch.turn_on:
      timer_ringing` → repeat-plays `timer_finished_sound`, and `set_has_timers(True)` follows
      from `on_timer_finished` alone, so `FEATURE_TIMERS` *is* advertised and our timer tool
      registers. First thing to establish: did the assistant **say** it had set the timer? If
      not this is the Norwegian phrasing miss under "Watch items", not a device problem.
      **The missing countdown is expected and won't be fixed** — the firmware has no timer UI at
      all (`voice_assist_timer_finished_phase_id: "20"` is defined but never appears as a `case`
      in `draw_display`, so it falls through to the idle page).
- [ ] **Session hangs — "stayed in listening mode and did not exit"** (field report). Prime
      suspect is the missing max-utterance cap (own section above), which this hardware's
      `auto_gain: 31dBFS` could plausibly trigger. Firmware-side candidate to rule out from the
      log: `on_end` contains an **unbounded** `wait_until (not media_player.is_announcing AND
      not speaker.is_playing)` before it restarts `micro_wake_word` — if that never resolves the
      device goes deaf with no recovery.
- [ ] **Confirm the identity sniff on a device with its STOCK name**, and the **mDNS scan** with
      it. Both field reports came from renamed units, and a renamed device never appears in the
      network scan — manual IP is the documented route for those.
- [ ] **Tune `initial_audio_skip` / `followup_audio_skip`** against the wake sound; both
      default to 0 and were never measured on this hardware.
- [ ] **Replace the stand-in artwork.** `drivers/m5stack-atoms3r/assets/` holds a drawn
      stylised front view, not a product photo. Swap in real images before the store release.
- [ ] **Ship a test build carrying `3020e3d`** so the tester can drop the rename workaround.
      The fix is on `dev` only; the build he tested predates it.

## Deferred with a deadline

- [ ] **Re-attempt the gpt-realtime-2.1 migration (deadline: before Jan 20, 2027).** The
  2.1 move (commit `1af0f56`) was reverted 2026-07-25: `gpt-realtime-2.1` has an open
  language-drift bug — it speaks non-English languages with a heavy English accent or
  drifts into English entirely, and prompting doesn't reliably fix it
  (<https://community.openai.com/t/gpt-realtime-2-1-exhibits-language-drift/1386953>).
  Symptom on the PE: Norwegian replies sounded "like a non-Norwegian trying to speak
  Norwegian". We're pinned to `gpt-realtime-2025-08-28` / `gpt-realtime-mini`, which
  OpenAI shuts off **Jan 20, 2027**. Before re-migrating (to 2.1 or newer): check the
  thread/changelog for a fix, then verify with a few Norwegian turns on the real PE.

## Watch items (no action unless they recur)

- **Timer-tool phrasing miss (2026-07-28, live test, Norwegian):** "START nedtelling ett
  minutt" did not trigger `set_timer` — the LLM said it can't do countdowns and called
  `get_local_time` instead; "SETT nedtelling ett minutt" worked. If it recurs, consider a
  line in the timer instruction block mapping start/begin-a-countdown phrasings to
  `set_timer` (mind cost-of-growth rule 1 — one sentence, inside the existing
  timers-enabled gate).

- **Settings webview one-off (2026-07-19, unreproduced):** one webview session where Save
  silently persisted nothing (no error shown; reopening showed old values; later sessions
  saved fine). Suspected dead webview bridge. Watch for recurrence before blaming our page.
- **TR playback choppiness — resolved itself with the keepalive fix (2026-07-20 soak clean):**
  during the flaky-link period each per-sentence FLAC's last ~200–300 ms was audibly cut on
  the TR. Plausibly the watchdog's connect/destroy churn disturbed announce sequencing. If it
  recurs on a stable link: candidate fixes are tail-padding segments with ~300 ms silence
  (device flag like `micGain`) or finding an early-stop in the TR's mpv announce path.

---

## Feature ideas — 2026-07-10 brainstorm (owner-approved, not yet started)

Ordered roughly by wow-per-effort. None are started; pick one and spec it before coding.
Avoids the items dropped in the 2026-07-07 triage (multi-timers, image analysis — see
[`COMPLETED.md` §6](./COMPLETED.md)), **except start-flows-by-voice, which the owner
un-dropped 2026-07-31** (see "Start a Homey flow by voice" below).

### Easy wins (fit the existing architecture almost directly)

- [ ] **Room-to-room intercom / broadcast** — *"tell the kids dinner is ready"*, *"announce
      upstairs that we're leaving in 5 minutes"*. `DeviceManager` already tracks every voice
      satellite and the announce/TTS path exists (the *Say* flow card); a
      `broadcast_message(room?, message)` tool is a thin layer over both. Turns the satellites
      into a whole-house intercom.
- [ ] **Household memory** — *"remember that the spare key is in the blue cabinet"* →
      `remember`/`recall`/`forget` tools persisted in app settings, stored facts injected into
      the system prompt. Makes the assistant feel personal rather than generic.
- [ ] **Weather for any location, not just home** — *"what's the weather in Paris?"*,
      *"will it rain in Bergen tomorrow?"*. Verified state 2026-08-07: weather is hard-wired to
      the Homey's own coordinates. `GeoHelper` reads lat/lon from `homey.geolocation`
      (`geo-helper.mts:83`), `WeatherHelper` injects exactly those into every Open-Meteo call
      (`weather-helper.mts:155`, `:230`, `:303`) and throws `No location data available from
      GeoHelper` when they're missing — no fallback location input. None of the five weather
      tools (`get_current_weather`, `get_weather_forecast`, `will_it_rain`,
      `get_weather_summary`, `get_outside_illumination`, `tool-manager.mts:1388`) expose a
      location parameter; the only arg any of them takes is `hours`. So an away-from-home
      question either falls through to `web_search` or gets answered from model knowledge.
      - **Fix:** optional `location` string on the weather tools → geocode via Open-Meteo's
        free `geocoding-api.open-meteo.com/v1/search` (no key, same provider) → pass those
        coordinates instead of GeoHelper's. Omitted `location` keeps today's home behavior.
      - **Cache:** `WeatherHelper` has a single global slot per query type (10 min validity,
        `weather-helper.mts:83`) — must become location-keyed or a Paris lookup will answer
        the next "what's it like outside?".
      - **Prompt cost:** five tool descriptions grow by a parameter each; check the delta in
        the `/feature-costs` meter before landing (cost-of-growth rule 1). Also drop the
        "at the user's location" wording from the descriptions and the "for the home's
        location" phrasing in `get_assistant_capabilities` (`tool-manager.mts:641`).
- [ ] **Start a Homey flow by voice** — *"kjør kveldsrutinen"*, *"start movie night"*. Owner
      request 2026-07-31; this **un-drops** the start-flows-by-voice idea from the 2026-07-07
      triage ([`COMPLETED.md` §6](./COMPLETED.md) — note the recorded objection there was
      really about its bundle-mate *unchunked flow-triggered replies*, which touches the
      announce race; nothing technical was held against flows themselves). Two tools:
      `get_flows` (list: id + name + folder, so the LLM can match a spoken name) and
      `start_flow(id)`.
      - **API side:** `homey:manager:api` is already granted and the HomeyAPI instance is
        live in `ApiHelper` — but it only exposes `devices` and `zones` today, so add a
        `flow` accessor (or go through `getApi()`) next to them. Homey has **two** flow
        kinds — standard Flows and Advanced Flows — with separate list/trigger calls;
        cover both or the feature will look broken for anyone on Advanced Flows. Confirm
        the exact homey-api method names and whether triggering needs the flow to carry a
        *"This flow is started"* trigger card before speccing.
      - **Prompt cost:** do NOT inject the flow list into the system prompt — a real Homey
        has hundreds of flows. List on demand via the tool, exactly like devices/zones
        (cost-of-growth rule 1). Gate the whole thing behind a `flows_enabled` setting
        (default off) with a `FEATURE_TOOLS` entry + a `refreshFlowTools()` reconciler, and
        add it to `/feature-costs`.
      - **Product decision needed:** a flow can do anything the user built into it —
        unlock doors, disarm alarms. Decide whether every flow is voice-startable or only
        opted-in ones (a folder, a name convention, or a per-flow allowlist in settings).
        The H4 `allow_unlock_via_voice` precedent is the model to follow if a gate is wanted.
- [ ] **Moods** — Homey has native Moods and there is no mood tool today. `list_moods` +
      `set_mood` via `ApiHelper`, same pattern as the zone/device tools. Covers the "scenes"
      ask; pairs naturally with the flow tools above (same `ApiHelper` extension).
- [ ] **Presence** — *"is anyone home?"*, *"is Anna home yet?"*. Read-only tool over Homey's
      user/presence API.
- [ ] **Accept full URLs (https) in the custom-pipeline host fields** — forum request
      2026-07-29 (user runs their pipeline containers behind a swag reverse proxy). Verified
      state: the dedicated backends take *Host + Port* and hardcode the scheme —
      `http://${host}:${port}` in `ollama-client.mts:51`, `whisper-client.mts:44`,
      `piper-client.mts:83` (LM Studio likewise) — so an https URL in those fields yields
      `http://https://…` and fails. Nothing validates the input; the placeholder ("e.g.
      192.168.1.50") is just what makes it look IP-only. **There is already a working route:**
      each stage's *OpenAI-compatible* backend uses a Base URL field, and
      `normalizeOpenAiBaseUrl()` (`local/openai-compat.mts`) only prepends `http://` to a bare
      host — a full URL keeps its scheme. Fix: let the Host fields take a full URL too (parse
      scheme/host/port, keep the Port field for bare hosts) and refresh the placeholders.
      Note Wyoming STT/TTS can't benefit — raw TCP, not HTTP, so an HTTPS proxy can't front it.

### High value, more work

- [ ] **Reply audio as a URL for speakerless devices (Sonos hand-off)** — ReSpeaker tester
      request 2026-08-07. His board has **no speaker**: he wants our TTS delivered as a URL so
      a flow can hand it to the Sonos app's *"Play URL `<url>` at volume `<volume>`"* action.
      Distinct from (and much easier than) the voice-input-only entry below: he still wants
      **our** TTS — our voice, our language — so none of the `LocalPipelineProvider`
      TTS-optional work applies and this can ship independently.
      **Re-asked 2026-08-10 (post #60), now with a workaround in hand:** he has a flow piping the
      reply *text* to his Sonos and finds the Sonos TTS voice poor — "but I can also play a url on
      sonos, would it be possible to have the output available as a url?". Confirms the design
      below is what he wants and that the `assistant-thinking`-to-Sonos-*Say* path works today, so
      shipping the new card is additive and breaks nothing for him.
      Findings from a full code read 2026-08-07 (all line refs verified, not guesses):
      - **The unchunked path already exists — do not build a third one.** He asked whether
        chunking could be made optional; `AudioOutputPipeline` has had two reply modes since
        the Org-1 refactor: `announce` (one FLAC per speech segment, played back-to-back —
        what he is seeing) and `inband`, which accumulates the whole reply's PCM and
        `buildReplyFile()` (`audio-output-pipeline.mts:125`) emits **one** FLAC URL for it.
        The mode is a single per-turn switch at `voice-assistant-device.mts:336`
        (`beginTurn(started.followUp ? 'inband' : 'announce')`). URL mode = force `inband`.
      - **Chunking only buys time-to-first-word on the device's own speaker** (segment 1 plays
        while the model still generates the rest). A flow fires once with one URL, so that
        benefit is zero here — forcing `inband` costs nothing but latency already being paid on
        the Sonos round trip.
      - **Expose it as one setting, not a raw "chunk / don't chunk" toggle** — chunking is an
        implementation detail. Per-device dropdown, e.g. *"Reply audio: play on this device /
        send as URL to a Flow"*, default **play on this device**; URL mode forces `inband`
        internally. Open question for the owner: all five drivers, or only the speakerless ones
        (ReSpeaker, AtomS3R without Echo Base)?
      - **Use a NEW trigger card, not a `url` token on `assistant-thinking`.** Sequencing rules
        the existing card out: it fires from the `response.done` handler
        (`voice-assistant-device.mts:805`) and `audioOutput.flush()` only runs at `:809`, so at
        trigger time nothing is encoded and there is no URL. Moving the fire point would change
        timing for every existing user. Add e.g. **"Reply audio ready"** with `url` + `text` +
        `duration` tokens, fired from the `reply-done` handler (`:488`) after `buildReplyFile()`.
        Extra reasons: `assistant-thinking` also fires per tool call (`type: 'tool'`) where a
        `url` token is always empty, and empty for every locally-playing device too — a footgun
        in the flow editor; its own hint calls it a debug card; and existing flows piping `text`
        to a Sonos *Say* card keep working untouched.
      - **BLOCKER he has not hit yet — Sonos will not play our 24 kHz FLAC.** Reply files are
        24 kHz mono 16-bit FLAC (`audio-output-pipeline.mts:128-132`). Sonos supports mono and
        "up to 48 kHz", but the documented/tested FLAC rates are 44.1 and 48 kHz; 24000 Hz is
        non-standard and Sonos is historically fussy — expect refusal or silent failure. Fix is
        cheap, both pieces already exist in `src/helpers/wav.mts`:
        `resamplePcm16Mono(pcm, 24000, 48000)` (exact 2× upsample, no quality question) then
        encode with `sampleRate: 48_000`. `pcmToWav()` is the fallback if his player still balks
        (Sonos definitely handles 16-bit WAV; the file lives 30 s so size is irrelevant).
        Needs a target-sample-rate parameter on `buildReplyFile()`.
        Refs: [Sonos supported audio formats](https://support.sonos.com/en-us/article/supported-audio-formats-for-sonos-music-library),
        [community thread on FLAC 24/48](https://en.community.sonos.com/controllers-and-music-services-228995/playing-flac-over-24-48-6842145).
      - **File TTL is too tight for a flow round trip.** Files are deleted 30 s after creation
        (`file-helper.mts:47`), extended by playback length only when *we* play them
        (`playUrlByFileInfo`, `:1152-1157`). `buildReplyFile()` does schedule with the
        extension, so the basics hold — but 30 s of grace is thin if the flow groups speakers,
        saves/restores the queue or ramps volume first. Raise the base grace (≈2 min) in URL mode.
      - **Build URL mode on `inband`, never on `announce`.** The announce path ends a turn on
        the device's `announce_finished` ack (`:432`), which is what calls
        `finishAnnouncePlayback()`; with nothing playing locally that ack never arrives and the
        turn hangs in `speaking`. The in-band path waits for no ack — it sends `tts_end` +
        `run_end` immediately — and its null-file branch (`:525-528`) already does the right ESP
        sequencing (`tts_end()` with no URL) so the LED ring still runs replying → idle. URL
        mode is essentially "in-band with the URL diverted to a flow token".
      - **Skip the baked-in listening chime in URL mode.** `appendChimeToPcm` at `:513` is only
        appended to keep-open replies; in URL mode `keepOpen` must be forced false, otherwise
        Sonos plays a "speak now" beep for a mic that is not reopening.
      - **Trade-off to tell the tester:** with chunking off he hears nothing until the *entire*
        reply is generated, then the Sonos hand-off on top — several seconds of silence on a
        long answer. The LED ring still shows thinking/replying, but it will feel slower than
        the PE does.
      - **Change set** (small, mostly one file): new dropdown in `driver.settings.compose.json`;
        mode force + URL branch in `voice-assistant-device.mts`; sample-rate param on
        `buildReplyFile()`; new `.homeycompose/flow/triggers/` card; `README.md` update — and
        **not** `README.txt` (App Store rule in CLAUDE.md).
- [ ] **Voice-input-only mode (reply spoken by some other speaker)** — forum request
      2026-07-29, owner-approved in principle. User wants the satellite as a *microphone only*
      and the answer spoken by the Sonos app's *Say* card, with no TTS container at all.
      Design: a per-device setting (e.g. "Play response on this device", default **on**);
      when off, skip playback entirely. Related but NOT the same as the URL hand-off above —
      that one keeps our TTS, this one removes it. If both ship, they are two values of the
      same per-device "reply audio" setting.
      - **The flow side already works** — no new trigger card needed. `assistant-thinking`
        fires with the finished reply and `type: 'reply'`
        (`voice-assistant-device.mts:805`). Flows MUST filter on that token: the same card
        also fires per tool call with `type: 'tool'`, so an unfiltered flow speaks
        "Using tool get_devices".
      - **DONE for the Custom pipeline (2026-08-07):** the TTS stage now accepts
        `local_tts_provider: 'none'` (`providers/local/none-clients.mts`), so no TTS container
        is needed — the None client satisfies the startup gates without touching the network,
        and `textToSpeech()` throws so the *Say* card reports an error instead of serving
        silence. Shipped alongside `local_llm_provider: 'none'` (forum request 2026-08-07: stop
        after STT and hand the transcript to a Flow).
      - **`local_llm_provider: 'none'` LIVE-VERIFIED on the PE 2026-08-09.** Flow: dump the
        transcript to the timeline on `assistant-heard`, wait 1 s, then *Say* "yes sir!" —
        heard on the PE. Confirms both halves: the transcript still reaches the trigger with
        no LLM in the chain, and the no-reply-audio turn closes itself (the `silent` report
        from `AudioOutputPipeline` on `reply-done`) instead of hanging waiting for an
        `announce_finished` that never comes.
      - **`local_tts_provider: 'none'` LIVE-VERIFIED on the PE 2026-08-09 — this IS the
        requested feature, working.** "What is the time?" → timeline showed the transcript,
        then `Using tool get_local_time`, then `It's 11:56 PM.` The full chain runs (STT →
        LLM → tool call → reply text out on `assistant-thinking`); only speech is removed.
        The mic-closed "end" tone still plays — it goes out via `playUrl()` from the LAN
        webserver, nothing to do with the TTS stage — and nothing follows it: no reply
        audio, no hang. Matches the `noOp` design (the provider skips the stage rather than
        calling it).
      - **That test also demonstrated the `type`-token footgun above**, live: the timeline
        received TWO `assistant-thinking` fires for one turn, `type: 'tool'`
        ("Using tool get_local_time") and `type: 'reply'`. Harmless in a timeline; a Flow
        wired to a *Say* card without the filter would speak the tool name out loud first.
      - **The *Say* card under `local_tts_provider: 'none'` also verified 2026-08-09**, and
        it behaves as designed: `textToSpeech()` throws at
        `local-pipeline-provider.mts:887-888` ("TTS backend is set to 'None' — this device
        cannot speak…"), the driver's run-listener catches it
        (`voice-assistant-driver.mts:111-113`) and the Flow editor shows the message rather
        than the card silently succeeding. That test also surfaced the Sentry-noise bug
        fixed the same evening ([`COMPLETED.md` §15](./COMPLETED.md)).
      - **Still open:** the same for the three realtime providers — they should be put in an
        audio→text mode rather than generating speech that gets thrown away; and this is a
        GLOBAL setting, so it cannot be per-device the way the original request imagined.
      - **Known trade-offs to document for the user** (both confirmed, not guesses):
        follow-up questions stop working, because continue-conversation keys off the device
        finishing its own playback — every turn needs the wake word again; and the external
        TTS round trip adds latency on top of the pipeline.
- [ ] **Device-less "Ask AI (text answer)" flow card — target 1.5.0** (forum request 2026-07-25,
      owner-approved). An APP-level action card (no device picker) so flows can use the AI with
      zero voice hardware: *"summarize my open windows and send a notification"*, yes/no
      questions, text generation. Design sketch (agreed 2026-07-25): new
      `.homeycompose/flow/actions/` card registered in `app.mts`; a **headless provider**
      through the existing `IVoiceProvider` seam/factory in text↔text mode (works with all four
      engines + configured key automatically), created lazily on first use and torn down after
      idle (don't hold an OpenAI realtime websocket open forever; local/Mistral LLMs are
      stateless HTTP); a **headless ToolManager** with the device-bound tools removed — no
      timers (`esp.supportsTimers` needs a satellite), no interim-speak, zone context "whole
      home" — everything else (DeviceManager control, weather, geo/time, web search, shopping,
      music) is already an app singleton. Serialize concurrent flow invocations like the
      device's textRequestQueue (H2 lesson); single-shot per invocation, no conversation
      carryover between flow runs. Explicitly SKIPPED from the same request: device-less timer
      cards — the satellite rendering (LED ring + chime) is the point of app timers, Homey's
      native delays/timer apps cover the device-less case, and a headless timer tool would grow
      every turn's prompt (cost-of-growth rule 1). Remember READMEs + feature-costs when built.
- [ ] **Reminders (the missing sibling of timers)** — *"remind me tomorrow at 8 to take out the
      recycling"*. Unlike timers these need persistence (app settings) and delivery: spoken
      announcement on the satellite that set it, plus a Homey timeline/push notification as
      backup if nobody's listening. The most-used feature on Alexa/Google that we lack.
- [ ] **Energy & history questions via Homey Insights** — *"how much power are we using right
      now?"*, *"how much energy did the heat pump use yesterday?"*. Read-only tool over the
      Insights API; gives the assistant the time dimension it completely lacks today.
- [ ] **Electricity spot prices (Nord Pool)** — *"when is power cheapest today?"*, *"should I
      run the dishwasher now or tonight?"*. Public API (e.g. hvakosterstrommen.no) → small HTTP
      helper + one tool. Pairs with the Insights tool for genuinely smart answers.
- [ ] **Calendar (read-only iCal/CalDAV URL)** — *"what's on today?"*. Opt-in like Bring!:
      paste an iCal URL in settings, one `get_calendar_events` tool. Also feeds the briefing
      card below.
- [ ] **"Morning briefing" flow card** — one flow-card action ("Play briefing on device") where
      the LLM composes weather + today's calendar + spot-price note + shopping list into one
      short spoken update. Pure composition of existing tools (plus calendar/spot prices).

### Stretch / just-plain-cool

- [ ] **Follow-me music** — we already control Music Assistant and know each satellite's zone;
      with per-zone motion/presence, *"follow me"* transfers the MA queue between Sendspin
      players as you move. Prototype behind an opt-in setting.
- [ ] **"Hey Homey" wake word on the TR** — researched 2026-07-28, full plan in
      [`docs/thirdreality-voice-and-music/custom-firmware.md`](./docs/thirdreality-voice-and-music/custom-firmware.md).
      **No custom firmware needed**: the TR implements HA's external-wake-word mechanism, so we can
      host a microWakeWord `hey_homey.tflite`/`.json` on our own `WebServer` and push it in
      `VoiceAssistantConfigurationRequest` (needs one added proto field — our vendored `api.proto`
      predates it). `applyWakeWord()` then activates it unchanged. Blocking unknown: getting a
      model that behaves (train via OHF-Voice/micro-wake-word or microwakeword.com).
      Sub-item worth doing on its own: **re-apply the configured wake word on connect** — the TR
      firmware never persists `active_wake_words`, so it reverts to `okay_nabu` on every reboot.
- [ ] **TR LED control** — same doc. The LED is a single RGB LED (`/sys/class/leds/RGB_*`) driven by
      the `tr-ledring` daemon via a D-Bus signal, and is **not exposed on the ESPHome native API**,
      so LAN control does require a firmware patch (add a Light or Select entity to
      `linux-voice-assistant-cpp`; `api.proto` already carries the Light messages, only client
      dispatch is missing). Decide ownership first — the satellite overwrites the LED on every
      pipeline state change.

### Deferred technical work

*(empty — the last item here, Noise encryption / code-review M2, was implemented and fully
live-verified 2026-07-24 and is archived with full context in
[`COMPLETED.md` §11](./COMPLETED.md).)*

**Suggested first picks:** intercom/broadcast, memory, and reminders — they change how the
product feels day-to-day. Moods and presence are cheap enough to bundle into any of them.

Remember: each shipped feature must update `README.md` + `README.txt` (and usually the agent
instructions/`get_assistant_capabilities`) before commit.

---

The 2026-07-07 session cleared this list: every item was either implemented (archived with full
context in [`COMPLETED.md`](./COMPLETED.md)) or explicitly dropped by the owner (dropped items and
their rationale are in [`COMPLETED.md` §6](./COMPLETED.md) in case any come back).

Add new work here as it comes up. Reference docs that used to feed this list:
- [`OPENAI_API_IMPROVEMENTS.md`](./OPENAI_API_IMPROVEMENTS.md) — OpenAI Realtime API audit (all items resolved)
- [`docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md`](./docs/home-assistant-voice-preview-edition/implementation-gap-analysis.md) — ESPHome native-API coverage vs. the PE docs
