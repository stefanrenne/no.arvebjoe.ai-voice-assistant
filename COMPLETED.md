# COMPLETED — archive of finished work

Done items moved out of [`TODO.md`](./TODO.md). The full context is kept here **so we don't
re-investigate** — several of these were expensive diagnoses. Section numbers mirror TODO.md.

Items marked *(verify pending)* are implemented and believed correct, but never got a real-world
test — the release-testing checklist was dropped in the 2026-07-07 triage (§6 below), so verify
ad-hoc if one of them misbehaves.

---

## 1. ESPHome device client (`src/voice_assistant/`)

- [x] **BUG (FIXED 2026-06-26): follow-up turn produced no audio on the PE.** Root cause: in a
  `startConversation` follow-up the reply was sent as a standalone `VoiceAssistantAnnounceRequest`,
  which the PE acks (`AnnounceFinished`) but never fetches once it is in conversation mode → silence.
  Fix: deliver the reply **in-band** on the pipeline's `TTS_END` carrying the FLAC URL (`tts_end(url)`),
  and drive the single mic-reopen ourselves via a `peConversationActive` session flag in
  `src/homey/voice-assistant-device.mts`. A secondary chain-blocker (the PE's mic-open noise burst on
  auto-reopened turns tripping OpenAI's server VAD → ~0.5s dead window) was fixed with a per-turn
  follow-up skip (`followup_audio_skip` setting, default `DEFAULT_FOLLOWUP_SKIP_MS` = 150ms — decoupled
  from the wake-turn `initial_audio_skip` so a follow-up's first word isn't clipped). **Single follow-up
  AND chained multi-question conversations both confirmed on PE firmware 2026.6.2** (diagnosed using
  the `[PE]` device-log stream, below). See the follow-up item in §3 and branch `fix/followup-turn-audio`.

- [x] **Conversation-flow hardening — 2026-07-02 fix round (commits 77bd40c…94f94aa).** All confirmed
  on the real PE unless noted (remaining warts stay open in TODO §1):
  - Broadened pairing device-type sniff so self-compiled firmware (no "Nabu Casa"/"PE" identity
    strings) is listed again.
  - Always-on `[CONVO]` conversation trace (wake→VAD→STT→tools→LLM→TTS→continue/stop) + new
    `tool.completed` provider event.
  - Spurious-VAD-trip retry (PE auto-reopen catches TTS echo → empty transcript <2.5s → reopen
    instead of ending session).
  - Suppress `response.done` for function_call responses (tool-turn replies were routed to the
    announce path mid-conversation and silently dropped).
  - `continue_conversation` sent as INTENT_END event data so the PE closes after non-question
    replies (the firmware flag is sticky — verified in esphome voice_assistant.cpp).
  - Playback-aware `lastTurnEndedAt` (+pcmBytes/48 ms) so long in-band replies don't eat the 10s
    context TTL and wipe the LLM context mid-conversation *(verify pending — re-run the 3-question quiz)*.

  Details: memory `followup-turn-no-audio-rootcause.md`.

- [x] **Device-log streaming for diagnosis (2026-06-26)** — opt-in `SubscribeLogsRequest` (id 28) over
  the native API streams the PE's own ESPHome logs back (`SubscribeLogsResponse`, id 29), printed inline
  under `[PE]` alongside the `[ESP]`/app logs. Gated by `ESP_LOG_LEVEL` (env var) or the `logLevel` client
  option; off by default, no serial/USB needed, works for the emulator and a real device. This is what
  made the follow-up-audio diagnosis tractable.

- [x] **BUG: devices not appearing in the pairing dialog on repeat attempts** — _fixed 2026-06-20._
  Root cause was a **reconnect leak in the discovery capability probe**, not firmware version (the
  original "v25.7 vs v26.4" framing was a red herring — both firmwares advertise `platform=ESP32` and
  pass the `txt.platform` discovery condition fine; Homey's regex match is case-insensitive).
  - **Real mechanism (confirmed live with ESP-client logging):** during pairing, the driver opens a
    one-shot `EspVoiceAssistantClient` probe per discovered device. If a probe errored or finished,
    `handleDisconnect()` would `emit('Unhealthy')` (→ driver `finish()` → `disconnect()`, which clears
    the reconnect timer) and **then** call `scheduleReconnect()` — setting a *new* timer after cleanup
    that nothing ever cleared. That orphaned timer fired `start()` → error → `scheduleReconnect()` →
    an infinite zombie reconnect loop, one per failed probe. The zombies kept hammering the device and
    occupying ESPHome's limited API connection slots, so the next dialog open failed with
    `read ETIMEDOUT` and showed no devices. An app restart killed the zombies (sockets die with the
    process) — which is why restarting "fixed" it and the first attempt always worked.
  - **Fix** (`src/voice_assistant/esp-voice-assistant-client.mts`): (1) `autoReconnect` flag derived
    from `discoveryMode` at construction — probes never reconnect; (2) terminal `closed` flag set in
    `disconnect()` so no reconnect can be scheduled after close, even from a late socket event;
    (3) `scheduleReconnect()` bails on `closed || !autoReconnect`; (4) strip socket listeners
    (`removeAllListeners()`) before `destroy()` in `disconnect()`/`handleDisconnect()`/`start()` so a
    dead socket's late close/error can't re-enter the reconnect path. Verified: repeated dialog opens
    now probe cleanly (`Scheduling reconnection` count = 0), both devices reappear every time.
  - **Related latent risk surfaced during investigation:** the newer PE firmware advertises
    `api_encryption_supported` (`Noise_...`). Plaintext still works while no key is set, but if a user
    sets an API encryption key, `api_encryption` appears and the plaintext-only client fails — see the
    Noise item in TODO §1.

- [x] **Timer support — voice-driven timers + alarms (2026-06-23).** `set_timer` / `cancel_timer` /
  `get_timer` tools; new `TimerManager` owns the authoritative countdown and sends
  `VoiceAssistantTimerEventResponse` (STARTED/CANCELLED/FINISHED) to the PE for the LED ring + finish
  chime. **Alarms** ("Sett alarm til kl 11") are timers with a duration the LLM computes from
  `get_local_time`. Re-arms the ring on reconnect. See
  [`docs/.../timer-feature.md` §9](./docs/home-assistant-voice-preview-edition/timer-feature.md).
  *(Single-timer-only limitation stays open in TODO §1.)*
  - **Resolved (verified on hardware 2026-06-23):**
    - A **finished/ringing** timer no longer blocks a new one — `startTimer` silently sends
      CANCELLED to stop the ring and starts the new timer (no "replace?" prompt). Only a *running*
      countdown triggers the TIMER_ALREADY_ACTIVE replace flow.
    - **LED ring re-arms on reconnect.** `reissue()` is fired from the `capabilities` event
      (handshake complete), NOT `Healthy` (which fires right after TCP connect, before the device
      subscribes to the voice assistant — a timer event sent then is dropped and the ring never shows).
    - **By design:** if a timer elapses while the device is disconnected, it does NOT ring on
      reconnect (`reissue` skips finished timers). Intended — a stale alarm shouldn't fire late.
    - **No device→host timer events to handle:** pressing the device button just triggers the mic
      (like the wake word); it does not dismiss the timer, so there's nothing to receive/clear.
  - [x] **Flow cards (done, hardware-verified 2026-06-23):** triggers (started/finished/cancelled),
    condition (timer-is-running), actions (start/cancel).
  - [x] **Tile capabilities (done, hardware-verified 2026-06-23):** read-only
    `timer_active` / `timer_remaining` (seconds, 1 Hz tick) / `timer_name` on the device card,
    on both drivers; the device mirrors the TimerManager lifecycle onto them.
  - [x] **LED-drift resync (done 2026-06-23) *(hardware verify pending)*:** `TimerManager` re-issues a
    quiet `UPDATED` with the authoritative `seconds_left` every 30 s while a timer counts down, so the
    PE's locally-ticked LED ring can't drift on long/alarm-length countdowns (skipped while
    disconnected; `reissue()` still re-arms on reconnect). _(gap analysis #5)_
  - (Timers are intentionally **not** persisted across an app restart — an in-flight timer is dropped,
    which is the expected, least-surprising behavior.)

- [x] **2026.1 handshake fix** — ESPHome 2026.1.0 (PE firmware 26.x) removed password auth;
  client no longer waits for `ConnectResponse`, stays backward compatible with 25.x. Verified on
  firmware 26.4.0. See `CLAUDE.md` → "ESPHome firmware compatibility".
  (The encryption item in TODO §1 is the remaining piece of the same area.)

- [x] Done in gap analysis: `WAKE_WORD_END`, `ERROR` events, `INTENT_PROGRESS`, version-check,
  `SubscribeStates`, extra entity-type handlers.

- [x] **Wake-word selection (2026-07-07, gap analysis #7).** The ESP client parses the wake-word
  data already present in `VoiceAssistantConfigurationResponse` (`available_wake_words`,
  `active_wake_words`, `max_active_wake_words`), stores it, and emits a `wake_words` event on every
  config response (fires on each connect and after a change). New client methods
  `getAvailableWakeWords()` / `getActiveWakeWords()` / `setActiveWakeWords(ids)` — the setter sends
  `VoiceAssistantSetConfiguration` (id 123, the same call Home Assistant uses) then re-requests the
  config so the cached state reflects what the device applied. PE device settings gained a read-only
  **Available wake words** label (kept in sync from the device, active one marked) and a **Wake word**
  text field; `onSettings` resolves the typed name/id case-and-separator-insensitively against the
  reported list and activates it, rejecting an unknown word with the available list in the error
  (which the SDK surfaces to the user). No new proto — the fields were always in `api.proto`.

---

## 2. OpenAI Realtime API (`src/llm/providers/openai-realtime-agent.mts`)

Audit items 1–7, 10, 12 are done — see [`OPENAI_API_IMPROVEMENTS.md`](./OPENAI_API_IMPROVEMENTS.md).
Sub-items of the still-open "Improve STT accuracy" work:

- [x] Switched the sidecar transcription model `gpt-realtime-whisper` → **`gpt-4o-transcribe`**
  (2026-07-02; `delay` removed — only supported by gpt-realtime-whisper). *(verify pending on real speech)*
- [x] **Text-anchored replies (2026-07-02)** *(verify pending on real speech)* — proven necessary same
  day: "Fortell meg en vits" transcribed perfectly but the model answered the *audio* with the local
  time. The agent now replaces the committed audio item with the transcript
  (`conversation.item.delete` + `sendUserText` + `createResponse`), so the model answers what
  `gpt-4o-transcribe` heard. Near-zero latency cost since we already waited for
  `transcription.completed`.
- [x] **#9 Model quality setting (2026-07-07).** New `openai_model` global setting (`full` |
  `mini`) with a "Model quality" dropdown in the OpenAI section of the settings page. `full` =
  `gpt-realtime-2025-08-28` (the previous hardcode), `mini` = `gpt-realtime-mini`. The model rides
  in the websocket URL, so the URL is resolved fresh in `start()` (`realtimeUrl()`) and the device
  forces a provider restart when the setting changes (`handleSettingsChange`). An explicit
  `options.url` still wins (tests / overrides).
- [x] **#11 Act on `rate_limits.updated` (2026-07-07).** `checkRateLimits()` in the agent: log
  warning when any quota window drops below 20% remaining; Homey notification below 5%, throttled
  to one per hour (`lastQuotaNotificationAt`) since the event arrives after every response.
- [x] **STT vocabulary prompt (2026-07-07).** The sidecar transcription now carries a `prompt`
  with the device/zone names: `DeviceManager.getVocabularyNames()` (unique zones + device names)
  → `ToolManager.getSttVocabulary()` → `sttVocabularyPrompt()` in `sendSessionUpdate`, capped at
  800 chars. Empty until the catalog loads — the next session.update (reconnect, settings change,
  30 s idle-timeout reopen) picks it up. *(Real-speech Norwegian verification never happened —
  dropped with the rest of the hardware checklist in the 2026-07-07 triage, test ad-hoc.)*
- [x] **#8 Simplify VAD response trigger — closed as won't-do (2026-07-07).** `create_response:
  true` would make the model answer the *audio*, undoing the text-anchored-replies fix above
  (the whole point is answering the far-more-accurate sidecar transcript). Rationale recorded in
  OPENAI_API_IMPROVEMENTS.md §8. Barge-in (`interrupt_response`) could be a separate future item.

---

## 3. Agent tools

- [x] **Follow-up / keep conversation alive (done 2026-06-26)** — answer follow-up questions without
  repeating the wake word (via `startConversation`). Single follow-up and chained multi-question
  conversations both work; the reply is delivered in-band on `TTS_END` and the PE auto-reopens the mic
  for each subsequent turn. The session ends on a silent turn (user has nothing to say) or after the
  context TTL. See §1 (follow-up audio bug, fixed) and branch `fix/followup-turn-audio`.

- [x] **Help! (2026-07-07)** — new `get_assistant_capabilities` tool: "what can you do?" returns a
  summary plus the live registered tool list (name + description), built from `ToolManager.tools`
  so it stays correct as tools come and go (timer tools only listed when the device supports them).
  The tool description instructs the model to summarize conversationally in the user's language.

- [x] **Web search (2026-07-07)** — new `web_search` tool for current/local info ("what's on at the
  cinema today?", "when does the next bus leave?"). Backend chosen by the `web_search_provider`
  setting (`src/helpers/web-search.mts`):
  - `openai` (default): OpenAI Responses API with the hosted `web_search` tool, reusing
    `openai_api_key`. The model searches AND summarizes; the tool returns `{ answer, sources }`.
    The device's IANA timezone is passed as `user_location.approximate` (Homey exposes no
    city/country) so "the local cinema" resolves. Model `gpt-5-mini`.
  - `brave`: Brave Search API (`brave_api_key`, free tier) — returns raw `{ results[] }` snippets;
    the voice agent's own LLM summarizes.
  - `disabled`: the tool returns a WEB_SEARCH_DISABLED error the model relays.
  Settings page: a "Web search" dropdown + a Brave key field shown only for the Brave backend.

- [x] **Music via Music Assistant (2026-07-09)** *(live verify pending — checklist in TODO.md)* —
  voice-controlled music on the PE and TR through a [Music Assistant](https://www.music-assistant.io/)
  server. **The audio never touches this app**: both devices are native Sendspin players (PE stock
  26.x firmware — see `sendspin:` in `.esp_home/home-assistant-voice.yaml`, merged upstream in
  ESPHome 2026.5; TR ships `sendspin-client`), and MA ≥ 2.7 streams to them directly. We are the
  control plane only:
  - `src/helpers/music-assistant-client.mts` — minimal client for MA's WebSocket JSON API
    (`ws://<host>:8095/ws`; command/result with `message_id` correlation, `partial` list-chunk
    accumulation, error mapping, lazy connect + reconnect-on-next-command). One shared instance
    app-wide (`getMusicAssistantClient()`). Commands used: `players/all`, `music/search`,
    `player_queues/get_active_queue`, `player_queues/play_media`, `player_queues/<transport>`,
    `player_queues/shuffle`. Protocol source: `music-assistant/models` api.py + the python/TS
    reference clients.
  - Four tools in `ToolManager` (Bring!-style opt-in gating on `music_assistant_enabled` +
    `music_assistant_host`): `search_music`, `play_music` (query or uri; media_type;
    play/next/add; radio_mode), `music_control` (pause/resume/stop/next/previous/shuffle_on/off;
    resume maps to `play` when paused, `resume` otherwise), `get_music_state`. Transport goes to
    the **active queue** (`get_active_queue`), so group playback is steered at the group leader.
  - Satellite→player mapping: the device passes a hint callback (IP from the store, Homey device
    name, zone); `resolveMusicPlayer` matches MA players by IP → device name → zone name, so
    "play X" targets the speaker being spoken to; explicit `player` arg (fuzzy name match) wins;
    failures return the available player names for the model to ask with.
  - Prompt block in `src/llm/instructions/music-instructions.mts` (12 languages, one shared file
    like the shopping-list block), gated by `supportsMusic` through `InstructionState` and
    `updateMusicSupport` on all three providers; device reconciles on settings change and
    restarts the provider when the active state flips (same dance as Bring!).
  - Tests: `tests/music-assistant-client.test.mts` (scripted in-process WS server: handshake,
    correlation, partials, errors, reconnect) and `tests/tool-manager-music.test.mts` (gating +
    handlers with a fake client). READMEs updated (music section + the previously missing
    ThirdReality hardware section).
  - Deliberately out of scope: XiaoZhi as a music target (no Sendspin client), MA volume tools
    (device volume already handled over ESPHome), event subscriptions (player/queue state is
    fetched on demand). The Homey MA app (`com.cyrilhendriks.musicassistant`) coexists fine —
    same MA API, different consumer.

---

## 4. Custom ESPHome / PE firmware

- [x] **Custom wake word "Hey Homey"** — done via [microwakeword.com](https://microwakeword.com/).
  Gotcha that cost hours: it must be **microWakeWord** (runs on-device), NOT **openWakeWord**
  (server-side) — they have near-identical names but an openWakeWord `.tflite` flashes fine then
  crash-loops the PE (`Failed to get registration from op code SHAPE` → LoadProhibited). Model lives
  in `.esp_home/wake_words/`, referenced from the config via a **`raw.githubusercontent.com`** URL
  (the `github.com/.../raw/` redirect form fails ESPHome's model validation). See
  [`.esp_home/CUSTOMIZATIONS.md`](./.esp_home/CUSTOMIZATIONS.md).

---

## 5. Local / offline AI

First round of the locally-hosted stack shipped 2026-07-05 (branch
`claude/local-stt-llm-tts-provider-oc0cng`, merged in PR #12). New `local` voice provider
(`src/llm/providers/local-pipeline-provider.mts`) selectable in app settings, with per-service
host/port boxes. Pipeline: on-device energy VAD (`local/simple-vad.mts` — the cloud providers'
server VAD has no local equivalent) → STT → LLM (full ToolManager tool loop) → TTS,
sentence-by-sentence while the LLM streams, resampled to the 24 kHz seam contract. Health probes +
reconnect campaign + 60 s idle re-probe drive device availability. *(End-to-end verification against
real services is still open — TODO §5.)* Backends delivered:

- [x] **Whisper STT over HTTP** (`local/whisper-client.mts`) — auto-detects `/asr` =
  whisper-asr-webservice, `/v1/audio/transcriptions` = speaches/faster-whisper-server,
  `/inference` = whisper.cpp. `local_stt_host`/port settings.
- [x] **Ollama LLM** (`local/ollama-client.mts`) — `/api/chat` streaming with the full ToolManager
  tool loop, strips `<think>` blocks from reasoning models. `local_llm_host`/port/model (model
  defaults to the first installed one).
- [x] **Piper TTS over HTTP** (`local/piper-client.mts`) — `POST /synthesize` with `POST /` fallback.
  `local_tts_host`/port settings.
- [x] **Mistral as an alternative LLM backend (2026-07-05).** Mistral has no unified realtime
  speech-to-speech API (their docs compose voice agents as STT→LLM→TTS). So the pipeline's
  LLM stage is pluggable behind `ILlmClient` (`local/llm-client.mts`, backend-neutral
  messages/tool calls): `local_llm_provider` setting = `ollama` (default) or `mistral`
  (`local/mistral-client.mts`, `/v1/chat/completions` SSE streaming + tool calling; gotcha:
  Mistral validates `tool_call_id` as EXACTLY 9 chars `[a-zA-Z0-9]`, hence
  `sanitizeToolCallId`/`generateToolCallId`). Settings page: LLM backend pulldown — Ollama shows
  host/port/model, Mistral shows API key (`mistral_api_key`) + model (`mistral_model`, default
  `mistral-small-latest`).
- [x] **Mistral Voxtral as alternative STT and TTS backends (2026-07-05)** *(verify pending against
  the real API)*. Same seam treatment for the other two stages (`ISttClient`/`ITtsClient` in
  `local/stt-client.mts`/`tts-client.mts`): `local_stt_provider` = `whisper` (default) or
  `mistral` (`local/mistral-stt-client.mts`, `POST /v1/audio/transcriptions` multipart, default
  model `voxtral-mini-latest`, override `mistral_stt_model`); `local_tts_provider` = `piper`
  (default) or `mistral` (`local/mistral-tts-client.mts`, `POST /v1/audio/speech` →
  WAV 24 kHz mono = the seam contract exactly). TTS request shape verified 2026-07-05 against
  Mistral's official Python SDK (generated from their OpenAPI spec): the voice field is
  **`voice_id`** (not `voice`). Two spec-vs-live-server gaps surfaced on a real device
  2026-07-06: `model` is marked optional but the server 422s without one ("No model provided
  for speech") — the client now always sends `voxtral-mini-tts-2603` unless
  `mistral_tts_model` overrides it; and the "20 preset voices" from the open-weights model
  card (`neutral_female` etc.) don't exist on the hosted platform (404 "Voice not found") —
  the platform serves its own library via `GET /v1/audio/voices` (30 voices, UUID ids +
  slugs like `en_paul_neutral`). The Voice dropdown is now populated live from that endpoint
  (`LocalPipelineProvider.getAvailableVoices(ttsBackend?)` went async,
  `/voices?provider=local&tts=…`), the stored value is the voice UUID, and a non-library
  `selected_voice` (legacy OpenAI/Gemini names) resolves to a neutral voice at synthesis.
  One shared `mistral_api_key` for all Mistral-backed stages; the settings page shows the key
  field when any stage picks Mistral, and each stage independently shows LAN host/port vs
  cloud model boxes. Any keyless Mistral stage → `missing_api_key`/`hasApiKey()=false`.
- [x] **Generic OpenAI-compatible backend for every stage (2026-07-05)** *(verify pending against
  real services)*. Third option (`openai`) in each stage's dropdown, with per-stage base URL /
  optional API key / model settings (`openai_stt_*`, `openai_llm_*`, `openai_tts_*` — stages
  may point at different servers). One implementation covers OpenAI itself, Groq
  (https://api.groq.com/openai/v1 — fastest tokens + dirt-cheap Whisper), OpenRouter, DeepSeek,
  LM Studio / llama.cpp / vLLM / LocalAI / Ollama's `/v1` shim (LLM), speaches (STT), and
  kokoro-fastapi (TTS). `local/openai-compat.mts` has the shared URL normalizer (bare host →
  `http://…/v1`; explicit paths kept verbatim) + `/models` health probe (401/403 → key error,
  404 tolerated); `openai-llm-client.mts` is the SSE chat client base class that
  `MistralClient` now subclasses (Mistral = same dialect + pinned endpoint + 9-char id
  sanitization); `openai-stt-client.mts`/`openai-tts-client.mts` mirror the audio endpoints.
  TTS voice: the Voice dropdown offers OpenAI's standard voices; the free-text
  `openai_tts_voice` override wins for custom servers (e.g. Kokoro's `af_heart`). API key is
  optional (LAN servers) — a keyed server rejecting shows up in the health probe.
- [x] **Wyoming-protocol STT backend (2026-07-05) — for `rhasspy/wyoming-faster-whisper` on
  TCP port 10300.** Real-world testing showed the user's "faster-whisper" docker is the Home
  Assistant Wyoming build — raw TCP with newline-JSON events + binary PCM payloads, NOT HTTP,
  so the HTTP `WhisperClient` can never reach it (that was the connect failure in the log).
  New `local/wyoming-protocol.mts` (framing per
  `docs/home-assistant-voice-preview-edition/wyoming-protocol.md`: header line with optional
  `data_length` side-band JSON + `payload_length` binary) and `local/wyoming-stt-client.mts`
  (`transcribe`→`audio-start`/`audio-chunk`×N/`audio-stop`→`transcript`, streaming
  transcript-chunk/-stop also handled; health check = `describe`→`info` with an `asr` entry).
  Fourth STT dropdown option "Wyoming — faster-whisper (local)" with its own
  `wyoming_stt_host`/`wyoming_stt_port` settings (default 10300); Test button supported.
- [x] **Wyoming-protocol TTS backend (2026-07-05) — for `rhasspy/wyoming-piper` on TCP port
  10200** (the user's Piper turned out to be the Wyoming build too).
  `local/wyoming-tts-client.mts` on the same protocol module: `synthesize {text}` →
  `audio-start`/`audio-chunk`×N/`audio-stop` collected into PCM at the announced rate; health
  check = `describe`→`info` with a `tts` entry. TTS dropdown option "Wyoming — Piper (local)"
  with `wyoming_tts_host`/`wyoming_tts_port` (default 10200); voice is server-side like HTTP
  Piper; Test button supported.
- [x] **LM Studio as a first-class LLM backend (2026-07-05).** It already worked through the
  generic OpenAI-compatible backend, but as a desktop app it gets the Ollama treatment:
  dropdown option "LM Studio (local)" with `lmstudio_host`/`lmstudio_port` (default 1234) and
  an OPTIONAL `lmstudio_model` (empty = auto-pick the first model from `GET /v1/models`,
  cached). `local/lmstudio-client.mts` is a thin `OpenAiLlmClient` subclass (keyless, host/port
  → base URL, `resolveModel()` named like Ollama's so the provider's health flow calls it).
- [x] **Per-stage "Test" buttons in the settings page (2026-07-05).** Each stage section has a
  Test button that POSTs the CURRENT (unsaved) form values to the app's new
  `POST /test-local-stage` endpoint (route in `.homeycompose/app.json`; handler in `api.mts` →
  `local/stage-tester.mts`) — the webview can't reach LAN services itself, so the test runs
  from the Homey box. Not just a ping: one real mini-request per stage (STT transcribes 0.5 s
  of silence, LLM answers "Reply with exactly: OK", TTS synthesizes "OK"), so wrong model ids,
  rejected keys and bad voices surface, with latency and the underlying cause (ECONNREFUSED …)
  shown inline. 30 s bound per test.
- [x] **Per-request Piper voice selection (2026-07-07).** `PiperClient` now sends the app's
  `selected_voice` as `/synthesize {voice}` (piper1-gpl supports it), but only after confirming
  the id against the server's own `GET /voices` dict (fetched once, cached) — so a stale
  cross-backend `selected_voice` (an OpenAI name / Voxtral UUID left over from a backend switch)
  falls back to the server default instead of 4xx-ing every synthesis; a server without `/voices`
  disables voice selection entirely. The Voice dropdown for the Piper backend lists the server's
  installed voices behind a "Server default voice" entry (`listPiperVoices` +
  `getAvailableVoices('piper')`). Sentinel `server-default` = no voice sent.
- [x] **Mistral Voxtral Realtime — streaming STT backend (2026-07-07).** Fifth STT dropdown option
  "Mistral Voxtral Realtime (cloud, streaming)" using Mistral's websocket transcription endpoint
  (`wss://api.mistral.ai/v1/audio/transcriptions/realtime?model=…`), much lower latency than the
  batch upload. `local/mistral-realtime-stt-client.mts` — the wire protocol was reverse-engineered
  from the official `mistralai` Python SDK v2.6.0 (`mistralai/extra/realtime/`), since the docs
  pages are behind a bot wall: on `session.created` send `session.update` with
  `audio_format {encoding:pcm_s16le, sample_rate:16000}` + `target_streaming_delay_ms:480`, then
  base64 `input_audio.append` chunks (kept under the 256 KiB decoded cap), then `input_audio.flush`
  + `input_audio.end`; collect `transcription.text.delta`, resolve on `transcription.done`. Shares
  `mistral_api_key`; optional `mistral_stt_realtime_model` override (default
  `voxtral-mini-transcribe-realtime-2602`). No language param — the model detects it. Test button
  supported. *(Verify against the live Mistral API — like the other Voxtral stages, only unit-tested
  so far with a fake websocket.)*

---

## 6. 2026-07-07 triage — dropped items

The old TODO list was emptied on 2026-07-07: every item was either completed (archived in the
sections above) or explicitly dropped by the owner. Dropped items and their context, in case any
come back:

- **§0 release-testing checklist** (3-question quiz re-run, LED-phase fidelity on the PE, fresh
  `[CONVO]` trace, STT changes on real speech, timer LED-drift resync, local pipeline against real
  services, README image refresh) — all needed real hardware; owner chose to test ad-hoc instead
  of tracking them. The README images (`.resources/settings.jpg` predates the provider redesign)
  are still stale — remember them before a store release.
- **§1 conversation-flow warts** — the multi-segment announce race (short first segment's ack
  arrives before segment 2 exists → premature turn-complete, self-heals by luck) and the
  keepOpen-with-no-audio edge (`peConversationActive=true` but no TTS URL → PE may not reopen).
  Details survive in memory `followup-turn-no-audio-rootcause.md` if the bugs resurface.
- **§1 multiple concurrent timers** — single-timer limitation stays; the agent asks to replace.
- **§1 ESPHome Noise encryption** — plaintext-only client stays; revisit when a user asks
  (a satellite with an API encryption key set cannot connect at all).
- **§2 #8 simplify VAD response trigger** — closed as won't-do (see §2 above).
- **§3 start flows by voice / change settings by voice / unchunked flow-triggered replies** —
  dropped; the unchunked-replies idea touches the announce queue with the known race, riskier
  than it looks.
- **§4 LED thinking-phase bug** (old white pulse despite `Cold Rainbow` in the config; suspected
  stale flash) — hardware-only diagnosis, dropped from tracking. The debug steps if it returns:
  confirm the running build via boot-log `compiled on` timestamp, verify the editor config,
  watch device LOGS during the thinking phase.
- **§5 SimpleVad threshold tuning / wake-word→reply latency measurement / optional auth on the
  LAN endpoints** — dropped.
- **§6 image analysis** — dropped (web search survived and was implemented).

---

## 7. Code review 2 fixes — 2026-07-12 (branch `claude/code-review-issues-4bi8d4`)

External review of `main` @ `0a64afa` archived in [`docs/code_review_2.md`](./docs/code_review_2.md);
every finding was verified against the code before fixing. The items below are FIXED with
regression tests; the review's remaining items (M2 Noise encryption, M5 stage-test validation,
M6 npm-audit chains, M7 start() semantics, L1/L3/L4/L5) stay open in TODO.md.

- [x] **H1 + L2 — settings save raced provider rebuilds/restarts.** One settings-page Save wrote
  ~20 keys; Homey fires one `set` event per key and `SettingsManager` emitted a full snapshot for
  each, so every subscriber (device rebuild/restart, local pipeline health re-probe) ran ~20×
  concurrently — a late `close→delay→start` continuation could act on a provider another update
  had already destroyed. Fixes: (1) `SettingsManager` debounces subscriber emits by 300 ms
  (`getGlobal` readers still see fresh values synchronously; `flushGlobalsEmit()` is the test
  hook); (2) the device serializes `handleSettingsChange` through a per-device promise queue and
  awaits `provider.restart()`; (3) the zone-change restart and the local pipeline's health
  re-probe no longer discard rejections; (4) the settings page (L2) promisifies all `Homey.set`
  calls, awaits them together, disables Save while in flight, shows one final error, and
  refreshes the voice list after the writes actually land (was a fixed 500 ms timer). Tests:
  burst-coalescing + final-snapshot + reset-cancels-pending in the pub/sub suite.

- [x] **H2 — concurrent "ask as text" Flow calls cross-wired answers.** `askAgentOutputToText`
  resolved via a shared `once('text.done')` with no request id, so two in-flight requests both
  consumed the FIRST answer. Now serialized through a per-device FIFO queue (exactly one pending
  listener); a failed entry doesn't wedge the queue. Bonus fix: an async
  `sendTextForTextResponse` rejection used to be discarded (request waited out the full 30 s
  timeout) — it now rejects immediately. Harness tests cover both.

- [x] **H3 — weather fetches could hang forever.** The three Open-Meteo `fetch()` calls had no
  `AbortSignal`; a stalled (not failing) connection would hang the awaiting caller — including
  `WeatherHelper.init()`'s diagnostic prefetch, which `app.mts` awaits during startup (a hang
  there kept every voice device offline), and any weather tool call holding a voice turn open.
  All three now use `AbortSignal.timeout(15 s)`.

- [x] **H4 (mitigation) — web search output marked untrusted.** Brave snippets / OpenAI-summarized
  answers went to the model verbatim: an indirect prompt-injection channel into a session holding
  `set_device_capability`. Both backends now wrap results with an explicit untrusted-content
  notice (data only; ignore embedded instructions; never operate devices because web content says
  so), and the tool description repeats the rule. Chosen over per-language prompt blocks because
  it appears at the moment the model consumes the data, works in every language, and costs no
  context when search is off. The one-device unlock cap stays the code-enforced backstop
  (deliberately not a confirmation prompt — see the S3 comment in tool-manager.mts).
  **Closed 2026-07-25 (owner decision: yes):** `allow_unlock_via_voice` global setting added,
  default OFF — `set_device_capability` refuses `locked=false` with `UNLOCK_DISABLED` until the
  user enables "Allow unlocking by voice" (toggle in the Smart home control settings card; key in
  `settingsManager.knownKeys`; read live at call time so no provider restart, no prompt-token
  cost). The single-device cap still applies once enabled. Locking is never restricted. Tests in
  `tool-manager-set-capability.test.mts` (H4 default-off, bulk lock allowed, S3 tests now enable
  the gate); README.md (features + settings + privacy) and README.txt updated.
  **Follow-up (live test, same day):** after flipping the setting ON, an immediate retry still got
  refused — the model trusted the earlier `UNLOCK_DISABLED` tool result sitting in the open
  conversation and answered from memory without calling the tool again (worked once the 10 s
  context TTL cleared it). Fix: `handleSettingsChange` now calls `provider.resetConversation()`
  after any settings save that didn't already restart the provider, skipped while a turn is live
  (`turn.state !== 'idle'`) so a save can't yank items from under a streaming response. Tests in
  `voice-assistant-device.test.mts` ("settings save clears stale conversation context").

- [x] **M1 — Wyoming framing/queue unbounded.** `drainBuffer` trusted `data_length`/
  `payload_length` verbatim (huge frame → unbounded buffering; negative/fractional/non-numeric →
  parser desync) and the event queue had no cap. Lengths must now be non-negative bounded
  integers (1 MB extra JSON / 32 MB payload), header line capped at 64 KB, queue at 1024 events;
  violations fail the connection and destroy the socket. Tests: huge/negative/fractional/
  non-numeric lengths, newline-less header, queue flood, legit-frame still parses.

- [x] **M3 — stale Music Assistant socket failed the new socket's commands.** The old socket's
  delayed `close` handler called `failAllPending()` unconditionally, so after a config change
  opened a replacement it rejected commands pending on the NEW socket. Pending commands are now
  only failed when the closing socket is still current (`this.ws === ws`); `disconnect()` still
  fails the old socket's own pending commands explicitly. Regression test reproduces the
  stale-close-after-reconnect ordering (confirmed red on the old code).

- [x] **M4 — audio-folder init raced first playback.** `app.mts` fired `initAudioFolder()`
  without awaiting; its cleanup deletes EVERY file in `/userdata/audio`, so an early reply-audio
  write could be deleted mid-startup (valid URL → 404 on the satellite). Now awaited before any
  device comes online.

- [x] **L3 — pairing probe polled every 10 ms and leaked the 5 s timeout (fixed 2026-07-25).**
  `checkVoiceCapabilities` (voice-assistant-driver.mts) resolved its promise via a 10 ms
  `setTimeout` poll loop watching a `done` flag, and never cleared the 5 s timeout timer (only
  `.unref?.()`'d it). Restructured to the pattern `probeManualEntry` already used: `finish()`
  resolves the promise directly (after listener detach + disconnect, so resolution now waits for
  cleanup like the manual path does), the timeout handle is stored and cleared in `finish()`,
  and a throw from `client.start()` now routes through `finish()` too — the old catch resolved
  without cleanup and leaked a half-constructed client's listeners. Behavior-preserving
  refactor; no unit tests exist for the driver probe — verified with a live pairing scan on the
  real Homey right after the change (2026-07-25, owner-confirmed working).

- [x] **L4 — dead pre-pad code in `pcm-segmenter.mts` (removed 2026-07-25).** `preStart` was
  computed and never used, and it turned out the `trailingBuffer` field was write-only (kept in
  `feed()`, reset everywhere, read nowhere — the post-pad is actually implemented by the
  `postEnd` arithmetic). Removed `preStart`, `trailingBuffer`, the `PRE_PAD_MS`/`PRE_PAD_BYTES`
  constants, and rewrote the misleading "captured POST_PAD in trailingBuffer" comment. Chose
  removal over implementing pre-pad trimming: the segmenter's playback behavior is live-verified,
  trimming inter-sentence silence would audibly change segment boundaries right before a store
  release, and the TR-choppiness watch item (TODO.md) makes audio-boundary changes extra risky.
  If snappier sentence gaps are ever wanted, the pre-pad idea is: trim a new segment's leading
  silence down to ~60 ms before its first speech frame. Zero behavior change — the 9 segmenter
  tests pass unmodified.

- [x] **L5 — process/SDK listeners now have symmetric teardown (fixed 2026-07-25).**
  `onUninit` previously only called the (empty) `WebServer.stop()`. Now: (1) the three
  anonymous `process` listeners in `setupGlobalErrorHandling` are registered via a new
  `addProcessListener` helper that records `[event, handler]` pairs, and `onUninit` removes
  them; (2) the `settingsManager.onGlobals(...)` remote-log subscription's unsubscribe fn
  (previously discarded) is stored and called; (3) new `dispose()` methods: `GeoHelper`
  (removes the `geolocation`/`clock` listeners — handlers kept as fields; safe when init
  bailed early), `DeviceManager` (removes the `device.update` listener, clears
  `zoneSubscriptions`), `ApiHelper` (`api.destroy()` — homey-api's Manager/API destroy
  removes all manager listeners and closes the Socket.io session). **Ordering gotcha:**
  DeviceManager must dispose BEFORE ApiHelper, because its unregister goes through the
  `apiHelper.devices` getter, which throws once the API is nulled. All removals are
  optional-chained (`removeListener?.`) so test fakes without the method stay valid. Tests:
  two new `app-init` tests (process-listener counts return to baseline; all three disposes
  called) + a DeviceManager dispose test (fake API extended with `removeListener`).
  656 tests + lint green.

- [x] **M5 — stage-test API body validation (fixed 2026-07-25).** `/test-local-stage` passed
  the posted body straight into `testLocalStage()`. New `validateStageTestRequest()` (exported
  from stage-tester.mts, called at the top of `testLocalStage` so the never-throws contract
  holds — failures return `{ ok:false, message }`): body must be a plain object; the string
  fields (`stage`/`backend`/`host`/`model`/keys/`url`/`language`/`voice`/`voiceOverride`) must
  be strings ≤ 2048 chars; `port` must be a string/number coercing to an integer 1–65535
  (empty string still means "backend default port"); `url` must be http(s) and carry no
  embedded credentials. **Scheme gotcha:** the scheme must be checked on the RAW value —
  `normalizeOpenAiBaseUrl` prefixes `http://` onto anything non-http (its bare-host default),
  which turns `ftp://x` into a weird-but-parseable http URL. Per the TODO decision there is
  deliberately NO loopback/LAN-range blocking or rate limiting — contacting arbitrary
  user-chosen LAN endpoints is the endpoint's purpose (documented in the validator comment).
  5 new tests, all asserting rejections never touch the network. 661 tests + lint green.

- [x] **M7 — provider `start()` readiness semantics (closed 2026-07-26, decision: document +
  close).** The review flagged inconsistent `start()` contracts (OpenAI resolves at "attempt
  initiated", local pipeline after health probes) plus fire-and-forgotten restart promises.
  Re-audit against current code showed the promise-discard sites were already fixed under H1
  (zone-change restart and the pipeline's settings health re-probe `.catch()` explicitly;
  the device's settings restart is awaited inside the serialized settings queue), and the
  four providers already share one coherent de facto contract: `start()` = begin the attempt,
  NEVER rejects on connection failure (failures emit `error`/`Unhealthy` and feed the
  provider-owned reconnect campaign; missing API key emits `missing_api_key` with no
  campaign), readiness is signaled by `open`/`Healthy` and queryable via `isConnected()`,
  `restart()` = `close()` + delay + `start()`. That contract is now DOCUMENTED on
  `IVoiceProvider.start()/close()/restart()` in `src/llm/voice-provider.mts` (plus the stale
  "only implementation is OpenAI" header fixed), so the guarantee is pinned at the seam every
  new provider implements. Centralizing lifecycle state (`stopped/connecting/ready/closing`)
  in a base class was deliberately REJECTED for now: pure refactor risk on live-verified
  reconnect behavior right before a store release, no user-visible gain — revisit only if L1
  (class splits) ever opens these files. Callers must keep the two rules in the doc: never
  gate on `await start()` meaning ready, and never retry `start()` around the campaign.

**Closes the "Wi-Fi setup via Bluetooth (Improv BLE)" TODO section — implemented 2026-07-16,
now FULLY verified on real hardware.** The feature: the PE/TR pairing wizard's "Set up Wi-Fi
via Bluetooth" path (fixes the miserable TR first-setup experience — previously HA-in-Docker +
the HA phone app just to push Wi-Fi credentials). Code: `src/ble/improv-ble-client.mts`
(protocol), `src/ble/improv-pair-handlers.mts` (pair socket wiring, unit-tested with fakes),
`drivers/{pe,tr}/pair/{start,improv_setup}.html` (views — identical copies, keep in sync),
`homey:wireless:ble` permission. Reference: `docs/wifi-provisioning-improv-ble.md`.

Verified in a live session with a factory-reset TR and PE: BLE long write ✓ (the go/no-go —
both devices provisioned), TR end-to-end ✓ (needs **no** authorization, connects
already-Authorized), PE end-to-end ✓ (center-button prompt), wrong-password retry ✓, mid-flow
abandonment cleanup ✓ (no dangling BLE connection), scan/advertisement-cache behavior ✓,
notifications ✓ (carry the state updates on Homey Pro; the 500 ms polling backstop is idle).
The session also root-caused two long-standing pairing complaints (TR mDNS discovery, the
Firefox blank dialog) and fixed the bugs below.

- [x] **TR invisible in "Find it on my network" — mDNS discovery condition.** The shared
  discovery config (`.homeycompose/discovery/esphome.json`) only accepted `txt.platform`
  matching `esp32|ESP32`; the TR is a Linux box advertising `platform=ThirdReality` (verified
  live with the emulator's `dns-sd` browser). The TR README's "discovery works as-is" claim had
  only checked the `_esphomelib._tcp` service name. Regex broadened to
  `esp32|ESP32|ThirdReality|thirdreality`. **When adding any non-ESP32 satellite, check its TXT
  `platform` value first.**
- [x] **Intermittently blank pairing dialog — Firefox, not us.** Breadcrumb logging proved the
  pair session always reached `onPair` while the first custom view never rendered (`showView`
  event never fired; backend-forced `session.showView()` ignored; the Homey served the view
  HTML 15/15 over the CLI). Chrome and the iPhone app: 100% reliable. Root cause confirmed by
  the owner: **Firefox's Enhanced Tracking Protection blocks the cross-origin `homeylocal.com`
  pair-view iframe** on my.homey.app; a normal `homey app install` (vs dev `homey app run`)
  also reduces the failure rate. Kept as permanent diagnostics: `[Pair]` session breadcrumb,
  `Pair view shown:` log, and a 2.5 s warn-only blank-view detector (a showView auto-nudge was
  tried and removed — the dead client ignores it).
- [x] **BLE wizard: per-driver device filter.** Both satellites in setup mode appeared in both
  drivers' Bluetooth lists. Added `deviceNameFilter` (improv-pair-handlers) driven by a new
  `VoiceAssistantDriver.improvNameFilter`: TR = `/3rspk|thirdreality/i`, PE =
  `/home[-\s]?assistan|ha[-\s]?voice/i`. **Gotchas that shaped the PE pattern:** the BLE
  advertisement name is NOT the mDNS/HA-app name — a factory 26.x PE advertises
  `ha-voice-pe-093b27` while the HA app displays `home-assistan-093b27` (GATT-read, truncated
  full name); BLE truncates to fit the 31-byte advertisement. Devices discovered WITHOUT a
  localName are always kept (ESPHome alternates name/service advertisements) — only
  positively-identified foreign devices are hidden, and the scan logs every advertisement's
  localName (`Improv adv:`) so future name mismatches are a ten-second diagnosis.
- [x] **"Press the button" prompt never showed (PE authorization).** The Improv client emitted
  'status' only on state TRANSITIONS, but an authorizer device is already in
  AwaitingAuthorization when provision() starts waiting → no event → the wizard stayed on
  "Sending Wi-Fi credentials…". `provision()` now emits the current state when entering the
  wait. Verified live: PE shows the center-button prompt; **TR needs no authorization at all**
  (connects already-Authorized).
- [x] **Post-BLE network search raced the device's Wi-Fi join.** Clicking "find it on the
  network" quickly showed an empty list (satellite takes up to ~1 min to join + announce).
  `list_devices` now holds its promise open (template shows its native "Searching…" spinner)
  re-scanning every 5 s until a device is found or a 2-min deadline passes — resolving empty
  early and emitting later leaves the template's "No new devices" text on screen (glitch is
  specific to the empty→found transition; appending to a populated list renders fine).
  Per-session probe cache distinguishes **definitive** rejections (device answered, wrong
  model — never re-probed) from **transient** failures (mDNS up, API not yet — retried every
  round); `checkVoiceCapabilities` now returns `{ device, definitive }`.
- [x] **Spurious "WebSocket was closed before the connection was established".** Adding a
  device fires its zone-resolve callback which calls `provider.restart()` while the OpenAI
  websocket is still CONNECTING; `ws` emits a synthetic error for close-during-connect that we
  logged + homey-log captured as an exception on every fresh pair. The error handler now
  swallows exactly that case while `isManuallyClosing` (one info line instead).
- [x] **TR kills the BLE link after a failed Wi-Fi join (wrong-password retry broke).** Improv
  spec says the connection stays open after error 0x03 (UnableToConnect) so credentials can be
  retried on the same link — and the handler deliberately kept the session for that. The TR
  instead silently resets its BLE stack: the retry write died with `ATT error: 0x0e` and the
  peripheral dropped (observed live 2026-07-19; the owner had to back out and reconnect
  manually). Fix in `improv-pair-handlers.mts`: track the last connected device; when a
  provision attempt fails with a TRANSPORT error (not an ImprovDeviceError/ImprovTimeoutError,
  which are real outcomes for the user), transparently reconnect — falling back to one rescan
  if the stored advertisement handle went stale with the device's BLE reset — and retry once.
  Also covers `improv_provision` arriving with no active session at all. Regression-tested with
  a `dropLinkAfterFailedProvision` fake. Also confirmed live: **notifications carry the Improv
  state updates on Homey Pro** (no `Could not subscribe` warnings; the 500 ms polling backstop
  is idle) — the last open Improv checklist item.

---

## 9. Post-1.4.0 hardening — live-test fixes & verifications (2026-07-19 → 2026-07-23)

- [x] **Live-verify the first-class Mistral provider — CORE VERIFIED 2026-07-19 on the
      Homey Pro + PE:** full spoken turns on BOTH `voice_provider: 'mistral-realtime'`
      and the Custom pipeline with all-Mistral stages (streaming Voxtral Realtime STT —
      transcript ready ~200 ms after mic close, so the `createStream` live-feed works;
      chat with real tool calls `get_local_time`/`get_current_weather`; Voxtral TTS reply;
      mic-close→speaking ≈ 2.7 s). Still unverified: the batch fallback when the STT
      websocket drops mid-utterance (hard to provoke), and an explicit check of the
      mirrored key/model inputs (`MIRRORED_INPUTS`) + Voxtral voice dropdown contents.
- [x] **Mistral LLM replies contain markdown — FIXED 2026-07-20 (prompt side; needs a live
      spot-check):** TTS was already protected (`SentenceSpeaker.cleanForSpeech` strips
      markdown since 2026-07-05) — the leak was in transcripts/logs/history. Fix: new
      `plainTextOutput` flag on `InstructionParams` appends a short "spoken plain text
      only, no markdown" block; the local pipeline (and therefore the Mistral provider)
      sets it. The block is counted in the settings budget meter's base cost
      (`feature-costs.mts`). Speech-to-speech providers unaffected.
- [x] **Bump `SettingsManager.EMIT_DEBOUNCE_MS` (300 ms) to ~1–2 s — DONE 2026-07-20
      (now 1.5 s, pubsub tests updated).** A real mobile-webview
      save burst (~30 sequential `Homey.set` calls) spreads wider than 300 ms, causing
      several redundant provider rebuilds + health probes per save (each a Sentry capture).
      Observed live 2026-07-19: one save produced staggered rebuilds (mid-burst config
      snapshots). Harmless but noisy.
- [x] **Unhealthy local pipeline double-reports each failed probe — FIXED 2026-07-20:**
      the `start()` health-check catch now reports loudly (logger.error → Sentry + the
      "error" emit that triggers the device's second capture) only on the FIRST failure
      of a reconnect campaign (`reconnect.attemptCount === 0`); retries log as warnings
      (no Sentry, no "error" emit). "Unhealthy" still emits every time so device
      availability stays correct; `idleHealthCheck` already single-reported.
- [x] **TR link stability — root-caused 2026-07-19, fix shipped, SOAK PASSED 2026-07-20:**
      overnight soak (~8+ h) with PE + TR both connected: zero disconnects, both answered a
      voice command cleanly in the morning — so the PE re-check also passed. App
      memory stable at ~40–50 MB idle all night (~65–70 MB during active turns), CPU 0%
      idle with a small ~10% blip every ~12 min (nothing of ours runs at that cadence —
      our periodic work is 30–60 s ticks — so that's Homey platform housekeeping/GC,
      not the app). Original context: three
      "Connection timeout - no ping received" disconnects at ~3 min idle cadence. Cause:
      our health check was purely passive (device must talk within `PING_TIMEOUT` 120 s);
      the PE chatters on its own but the TR's Linux firmware goes silent when idle, so
      our own watchdog was killing a healthy link. Fix: the client now sends `PingRequest`
      itself once the link is quiet (health-check tick, `esp-voice-assistant-client.mts`)
      and the `PingResponse` refreshes liveness. _Verified 2026-07-19: 12+ min idle soak
      with zero disconnects (old cadence was a drop every ~3 min), then a wake worked
      instantly with no reconnect._
- [x] **Feedback sounds made generic + error feedback added — DONE, real recordings pushed
      2026-07-23:** the old `please_set_api_key.flac` named OpenAI specifically,
      which is wrong now that Gemini/Mistral/local are supported. Reworked `.sounds/` into a
      provider-agnostic set (`src/helpers/sound-urls.mts` + `.sounds/README.md`):
      `wake_word_triggered`, `api_key_missing` (generic, replaces the OpenAI clip),
      `agent_not_connected`, a NEW `error` clip, and a NEW `device_connected` clip. The device
      plays `device_connected.flac` **once** on the first successful ESP handshake after pairing
      (gated by a `justPaired` store flag set in `onAdded`, cleared in the `capabilities`
      handler) so the user hears the satellite is now linked to Homey. The device now plays `error.flac` on a
      genuine **mid-turn** failure (agent `error`/`Unhealthy`/`close` while a turn is in flight)
      via `abortCurrentTurn(reason, playError)` — previously the user got total silence when a
      reply died in flight. Silent by design when no turn was active (idle reconnect) or the ESP
      link itself dropped (can't play anyway) or on an expected teardown (provider switch).
      Real recordings for `device_connected`, `api_key_missing`, `agent_not_connected` and
      `error` were recorded, pushed to main and live-verified on the PE 2026-07-23 (the
      welcome-sound path confirmed end-to-end via VictoriaLogs). `wake_word_triggered.flac`
      was deliberately left as-is — the app never plays it (the wake chime comes from device
      firmware; the only code reference is a comment in `esp-voice-assistant-client.mts`).
      Gotcha for future sound updates: `SOUND_BASE` serves from raw GitHub `main` behind
      Fastly (`max-age=300`, per-encoding cache variants), so the satellite can play a stale
      clip for up to ~5 min after a push — wait it out, a device reboot won't help.

---

## 10. Music Assistant live verification — MA 2.9.9 (2026-07-20)

Closes the "Music via Music Assistant (PE + TR)" TODO section. The control-plane integration
was implemented and unit-tested 2026-07-09 (§3 above); this session verified it against the
owner's real MA **2.9.9** (Linux server, `192.168.0.10:8095`; the duckdns HTTPS URL is UI-only
— the app uses the LAN IP/plain ws). The music audio itself never touches this app — Music
Assistant ≥ 2.7 streams to the PE and TR directly over Sendspin.

First finding: **MA requires token auth since API schema 28 (MA 2.9) — the shipped client
couldn't connect at all** (error_code 20 on every command; beware: an unauthed `players/all`
error was easy to misread as "0 players"). Fixed same day: `music_assistant_token` setting
(long-lived token from the MA web UI profile), `auth` command sent after the server-info frame
when schema ≥ 28, helpful create-a-token / token-rejected errors, settings-page field, fake
MA server now enforces auth in tests, READMEs updated. Pre-2.9 servers still work tokenless.

Second finding (2026-07-20, via authenticated `players/all`): **both satellites ARE
discovered** (PE `Home Assistant Voice 0908d1`, TR `3RSPK-A8E29151DBAD` — note: provider is
`universal_player`, not `sendspin`, on MA 2.9), **but `device_info.ip_address` is null for
both**, so the shipped IP-first auto-match could never hit. Fixed same day: the player hint
now carries the satellite's **MAC** (`store.mac`, from mDNS TXT) and `resolveMusicPlayer`
matches MAC first — against `device_info.mac_address` (PE) or embedded in the player_id/name
(TR) — then IP, then name/zone. Unit-tested against the exact live shapes.

- [x] MA discovers the PE (stock 26.x firmware) and TR as Sendspin players; check what the
      players' `device_info.ip_address` / names look like so the satellite→player auto-matching
      in `resolveMusicPlayer` actually hits — VERIFIED 2026-07-20, see the findings above
      (discovery yes; IP null → MAC-hint matching added, live-confirmed by per-device targeting).
- [x] End-to-end voice flow on both devices — VERIFIED 2026-07-20 (PE + TR, MA 2.9.9):
      play by artist (incl. STT-typo'd names absorbed by MA search: "Heillung"→Heilung),
      pause/resume/next, shuffle, "what's playing?" (full now-playing string + queue count),
      explicit player targeting by name (user renamed the web player to "Legion" and targeted
      it by voice — tip: renaming MA players to speakable names works great). One fix shipped
      mid-test: **play_media timeout 15s→45s** (`PLAY_MEDIA_TIMEOUT_MS`) — MA resolves a
      first-played artist from the provider BEFORE answering, ~27-30s observed, so every
      new-artist play falsely failed on the old 15s cap.
- [x] Announcement ducking while Sendspin music plays — VERIFIED 2026-07-20 on BOTH devices:
      music volume ducks when spoken to, reply plays, volume restores after. Identical
      behavior on PE (XMOS) and TR (WebRTC/PulseAudio).
- [x] Wake word while music is playing — VERIFIED 2026-07-20 on both devices (commands
      understood over playing music; correct per-device targeting via the MAC hint).
- [x] `resume` behavior on a long-stopped queue — VERIFIED 2026-07-20: PE queue stopped ~5 min,
      "resume" picked up exactly where it left off (resume→`play` mapping on the idle queue).
- [x] Partial-result accumulation: considered covered — live searches + a 1277-track queue
      exercised the real server paths; chunked-list accumulation stays unit-tested (no MA
      command we use returns partials at our limits).
- [x] **Slow-play acknowledgement — IMPLEMENTED 2026-07-20 (owner-requested):** if
      `play_media` is still pending after 4 s, the satellite speaks "Putting on X, one
      moment." (12 languages, `getPlayAcknowledgement` in `music-instructions.mts`) via a
      new `ToolManager.setInterimSpeak` seam registered by the device (routes to
      `speakText`). The ack timer is cancelled when the command answers fast, so quick
      plays aren't double-confirmed. Unit-tested (slow/fast/localized). Alternative
      "faster play path" (top track first, extend queue after) explicitly not chosen.
      **Follow-up same night:** a big artist catalog (Rammstein) blew even the 45 s
      `play_media` timeout — but MA completes the command late and the music starts anyway
      (verified live: queue had 283 items; the owner heard it start). So a `play_media`
      timeout now returns `ok:true, status:'preparing'` ("tell the user it's on its way")
      instead of MUSIC_UNAVAILABLE — timeouts get `err.code='MA_TIMEOUT'` in the client;
      real command errors still fail. Raising timeouts further is a losing game: resolve
      time scales with catalog size and provider latency. Timeout then LOWERED 45→30 s
      (owner: "people are impatient") — safe now that timeout = "say it's on its way",
      not failure. Live sequence for a slow artist: ack at 4 s → "on its way" at ~34 s →
      music starts by itself.

---

## 11. Noise encryption for the ESPHome link (code-review M2) — 2026-07-24 (branch `feature/noise-encryption`)

Closes the "Noise encryption" deferred-work item. The plaintext-only client used to fail
entirely against any satellite with an ESPHome API encryption key (`api: encryption: key:`
— the default once a device has been adopted by Home Assistant); users were told to remove
the key. Now the app speaks `Noise_NNpsk0_25519_ChaChaPoly_SHA256` and the whole pairing UX
routes around the key. Research + design doc (wire format, handshake crypto, node:crypto
mapping, error taxonomy): [`docs/esphome-noise-encryption.md`](./docs/esphome-noise-encryption.md).

**What shipped:**

- [x] **Codec** — `src/voice_assistant/noise-frame-codec.mts`: self-contained NNpsk0
      handshake + transport (CipherState/SymmetricState/HandshakeState), **node:crypto only**
      (no new dependencies; state-machine approach ported from hjdhjd/esphome-client's
      `crypto-noise.ts`, ISC). Outer frame `[0x01][u16 BE len][payload]`; inner message
      `[u16 BE type][u16 BE len][protobuf]`. Role-aware handshake so the unit tests run a
      real responder. Strict PSK validation (`decodePsk`: base64 → exactly 32 bytes;
      `Buffer.from(str,'base64')` alone is too lenient — it silently drops bad chars).
- [x] **Client seam** — `esp-voice-assistant-client.mts` options `encryptionKey`/`expectedMac`.
      Fresh codec per connect (ephemeral keys are single-use), client-hello + handshake msg 1
      in one write, `HelloRequest` held until `ready`. Plaintext path byte-for-byte unchanged
      when no key is set. A plaintext connect answered with indicator `0x01` emits
      `requires_encryption` (previously: silent hang until the health check gave up). Noise
      failures emit `encryption_error` with codes `wrong_key` / `plaintext_device` /
      `mac_mismatch` / `invalid_key` / `protocol_error`. Shared body decode via
      `decodeBody`/`encodeBody` in `esp-messages.mts` — one protobuf path for both framings.
- [x] **Key storage** — per-device `encryption_key` setting (PE + TR
      `driver.settings.compose.json`, type `password`); fallback: pair-time
      `store.encryptionKey`. `onSettings` validates (32-byte base64) and reconnects.
- [x] **Pairing, manual entry** — optional "API encryption key" field in
      `pair/manual_entry.html` (both drivers, identical copies), client-side pre-validation,
      full error-message taxonomy (wrong key / plaintext device / requires key / malformed /
      MAC mismatch), key threaded `manual_probe` → `probeManualEntry()` → client options and
      saved to both store and setting on success.
- [x] **Pairing, network scan detour** — encrypted devices (mDNS `txt.api_encryption`, or a
      probe hitting the Noise indicator) are listed marked **"(needs encryption key)"**
      without identity probing; `list_devices` navigates to a new `encryption_check` view
      (system *loading* template) whose server-side `showView` handler routes encrypted
      selections to `manual_entry` with the address prefilled (`manual_get_prefill`
      handler), everything else on to `add_devices`. The loading-view hop is the documented
      SDK pattern and avoids the race where the system add-view would add the device
      without a key. Gated by `supportsEncryptedPairing` (true for PE/TR, **false for
      XiaoZhi** — its pair flow has no manual_entry view, so encrypted devices stay hidden
      there). `improv-pair-handlers.mts`'s `onShowView` callback is awaited now (it owns the
      session's single `showView` handler; the router needs async navigation).
- [x] **Tests** — `tests/noise-frame-codec.test.mts`: 20 tests running a full loopback
      handshake against a responder built from the same primitives, byte-by-byte TCP
      chunking, both transport directions with advancing nonces, the whole error taxonomy,
      PSK validation, and the client seam (deferred encrypted HelloRequest, wrong-key event).

**Live verification — ALL PASSED 2026-07-24** on the owner's real hardware
(`homey app run`), full pairing permutation matrix: **PE and TR × network scan / Bluetooth
Wi-Fi wizard (factory reset) / manual IP × with and without encryption — every combination
works.** This also settles the §4.1 unknown: **chacha20-poly1305 is available in Homey's
Node build** (the zero-dependency route holds; the `@noble/ciphers` fallback was never
needed). Test firmware: `.esp_home/home-assistant-voice.yaml` has a key baked in since
2026-07-24 (see the `api: encryption:` block) — remember the owner's PE runs encrypted now;
remove/change the key there if a plaintext test target is ever needed again.

**Gotchas for future work:**

- Noise frames are fixed 3-byte header + u16 **big-endian** length — do not reuse the
  plaintext varint framing code. The inner length field on RX is deliberately ignored
  (decrypted buffer size is authoritative), same as aioesphomeapi.
- Nonce: 12 bytes = 4 zeros + u64 counter **little-endian**, per direction, +1 per frame;
  frames must be decrypted in order.
- The canonical wrong-key signal is the server's literal `"Handshake MAC failure"` text
  (or a local tag failure on message 2) — keep mapping it to a precise "wrong key" message.
- Encrypted devices can't be identity-sniffed at scan time, so driver filtering uses the
  mDNS `platform` TXT record: ThirdReality announces `platform=ThirdReality`; PE and
  XiaoZhi both announce `esp32` and are indistinguishable until the keyed manual probe
  runs its authoritative deviceType check.

---

## 12. Pre-release small-stuff punch list (2026-07-23 → 2026-07-31)

The punch list that cleared the remaining small items before the store release: the leftover
code-review findings (context in [`docs/code_review_2.md`](./docs/code_review_2.md); earlier
fixes in §7 above), the release-testing checklist, and the full custom-pipeline backend matrix.
Every item below was completed or explicitly closed with a decision; the one item that was NOT
finished — **L1 (split oversized classes / reduce `any`)** — stays open in
[`TODO.md`](./TODO.md). Numbers are the original punch-list numbers, because several entries
cross-reference each other by number. **M2 (Noise encryption)** was part of the same push and
is archived separately in §11.

1. [x] **H4 product decision — `allow_unlock_via_voice` setting?** DONE 2026-07-25 (owner said
       yes): default-off global setting gates `locked=false` in `set_device_capability`
       (`UNLOCK_DISABLED` until enabled; single-device cap still applies after). Toggle lives in
       the Smart home control settings card; READMEs updated; tests green. Details in
       §7 above (H4 entry).
2. [x] **L3 — pairing probe polls every 10 ms and leaks the 5 s timeout** DONE 2026-07-25:
       `checkVoiceCapabilities` restructured to the `probeManualEntry` pattern — `finish()`
       resolves the promise directly (no 10 ms poll loop), the timeout handle is cleared in
       `finish()`, and a `client.start()` throw now also runs cleanup (was a leak). Details in
       §7.
3. [x] **L4 — dead `preStart` variable in `pcm-segmenter.mts:134`** DONE 2026-07-25: removed
       (not implemented) — plus the write-only `trailingBuffer` state and the `PRE_PAD_*`
       constants, all dead. Zero behavior change (segmenter tests unchanged and green).
       Rationale + details in §7.
4. [x] **L5 — no teardown for process/SDK listeners** DONE 2026-07-25: `onUninit` now removes
       the three process listeners (stored via `addProcessListener`), unsubscribes the
       remote-log `onGlobals` subscription, and calls new `dispose()` methods on GeoHelper,
       DeviceManager (before ApiHelper — it unregisters through `apiHelper.devices`) and
       ApiHelper (`api.destroy()`). Covered by 3 new tests. Details in §7.
5. [x] **M5 — stage-test API hardening** DONE 2026-07-25: `validateStageTestRequest()` in
       stage-tester.mts — body shape, string-field types + 2048-char cap, port 1-65535,
       http(s)-only URLs without embedded credentials. Deliberately NO loopback/LAN blocking
       (the endpoint's purpose). 5 new tests. Details in §7.
6. [x] **M6 — npm audit legacy chains** DONE 2026-07-26: re-ran `npm audit --omit=dev` —
       0 critical/high (2 low, 7 moderate). Fixed the one actionable finding: protobufjs
       7.5.x DoS advisory (GHSA-j3f2-48v5-ccww) → 7.6.5 via `npm audit fix` (semver-safe;
       esp-messages + noise-codec tests green). The rest are the known upstream chains —
       `homey-log`→raven (cookie/uuid, no fix) and `homey-api`→socket.io-client 2.x
       (parseuri; npm's "fix" is a homey-api DOWNGRADE — do not apply). Closed as
       tracked-upstream; optionally nudge Athom for updated releases.
7. [x] **M7 — provider `start()` readiness semantics** DONE 2026-07-26 (decision: document +
       close). The de facto contract was already consistent across all four providers —
       `start()` = "attempt initiated", never rejects on connect failure, provider-owned
       reconnect campaign, readiness via `open`/`Healthy`/`isConnected()` — and the
       fire-and-forgotten call sites were fixed under H1. Contract now documented on
       `IVoiceProvider.start()/close()/restart()` in `src/llm/voice-provider.mts`.
       Centralizing lifecycle state = deliberate non-goal (goes with L1 if ever). Details in
       §7.
8. [x] **TR mic gain refinement** DONE 2026-07-26: new `mic_gain` device setting (PE + TR
       drivers' `driver.settings.compose.json`; number 0–20, default **0 = automatic** = the
       driver's built-in default, so the code constant stays authoritative and existing
       devices keep exact current behavior). `micGain` is now a mutable field resolved via
       `resolveMicGain()` (0/unset/invalid → `defaultMicGain` — the renamed subclass override,
       TR = 4; positive values clamped 1–20); applies live in `onSettings`, no reconnect. Gain
       loop now `Math.round`s (fractional gains would make `writeInt16LE` throw). Clip
       sanity-check (analytical): TR close speech ~330–430 int16 RMS → ×4 stays well under
       32767 even at peak; the clamp catches extremes, and the setting itself is now the
       mitigation if a loud talker ever distorts (turn it down). Live confirmation on the TR
       stayed part of the release-testing items (10–29, under item 14). 5 new harness tests;
       README.md settings + troubleshooting updated (README.txt doesn't enumerate per-device
       tuning — unchanged); app.json recomposed, `homey app validate` green at publish level.
9. [x] **README/store-listing polish:** ~~retake the stale settings screenshots~~ (done
       2026-07-26 — `.resources/settings.jpg` replaced by seven section screenshots:
       `settings_general.png`, `settings_smart_home.png`, `settings_weather.png`,
       `settings_web_search.png`, `settings_music.png`, `settings_custom_pipeline.png`,
       `settings_logging.png`, reflecting the section-dropdown redesign). ~~add the
       plaintext-only/no-Noise limitation note~~ (superseded — Noise encryption shipped);
       ~~spot-check README.txt~~ (done 2026-07-26 — accurate, incl. locks/encryption).
10. [x] Wake-word model (0.98 cutoff) DONE 2026-07-28: verified through ~9 days of daily
         use on the PE (firmware running since ~07-19) — wakes reliably at distance and
         with the TV on, no meaningful false accepts. 0.98 stays the shipped cutoff.
11. [x] Mic auto_gain 6 dBFS DONE 2026-07-28: same 9-day daily-use window — transcripts
         accurate, no audible clipping/distortion. 6 dBFS stays the shipped value.
12. [x] LED voice-phase rainbows: distinct listening/thinking/replying, seamless position
         handoff, dark-level looks right
13. [x] Timer round-trip on the satellite DONE 2026-07-28 (live, real PE + Homey Pro):
         voice "Sett nedtelling ett minutt" → `set_timer` tool ok → verbal confirmation,
         LED ring countdown, chime + blue flashing LEDs at zero. Note: the phrasing
         "START nedtelling ..." did NOT trigger the tool (LLM claimed it can't do
         countdowns and read the clock instead) — candidate agent-instruction tweak,
         tracked under Watch items in TODO.md. Stopping the chime with the button also
         verified.
14. [x] Smart-home control regression DONE 2026-07-28 (live, real PE + Homey Pro, all in
         Norwegian): **on** (Trimrom zone → 4 lights, 3 success + 1 unreachable reported
         per-device and relayed in the reply), **zone targeting** (Trimrom, Kontoret via
         get_zones → get_devices), **dim** ("Dimm taklyset på kontoret til 10 prosent" →
         dim 0.1, then back to 1.0 with the model reusing the device id from context —
         no re-query), **H4 lock path**: voice-lock success; unlock with
         `allow_unlock_via_voice` ON succeeded single-device (the toggle turned out to be
         enabled — flipped during the 07-26 settings screenshots, worth remembering as a
         hazard of screenshot sessions); with the toggle OFF the gate refused with
         UNLOCK_DISABLED and the agent explained the setting by name. Note: the LLM
         sometimes tries `get_devices_in_standard_zone` first for a named room and asks
         instead of jumping to the zone lookup — harmless, self-corrects.
15. [x] Settings page in the real mobile-app webview: rendering, section dropdown, sticky
         footer, budget-meter tap breakdown, stage Test buttons (verified through Homey's
         API routing in the 07-19 pass).
16. [x] Spurious-retry window: live test 2026-07-28 **caught a real bug** — a silent
         follow-up window ended after 30 s with a hallucinated transcript ("Kronborgsvingen
         62, slå av soverom taklys", built from our own STT vocabulary prompt) and the agent
         REALLY turned off the bedroom light. Root cause: `turn_detection.idle_timeout_ms:
         30000` makes OpenAI **commit** the speech-free buffer on timeout
         (`input_audio_buffer.timeout_triggered`, no handler existed); gpt-4o-transcribe then
         hallucinates from room tone + vocab prompt, and our transcript handler anchored a
         response on it. The PE LED never left "waiting" — server VAD correctly saw no
         speech the whole time. FIX (same day): handle `timeout_triggered` — mark the item
         id, emit `silence` (mic closes like a normal end-of-utterance), and when that
         item's transcript arrives discard it as silence + delete the audio item. Tests
         green. Re-verified live same evening — silent follow-up → "Idle
         timeout" + "Discarding transcript" warns (the STT hallucinated ANOTHER command,
         "Slå på terasse", proving the class of bug), no tool call, conversation closed
         cleanly. No spurious retry observed in any of the session's turns either.
         Follow-up refinements same night (owner-requested, both live-verified): idle
         timeout 30 s → 10 s, and a descending mic-closed chime (A5→E5, the listening
         chime mirrored — `ensureMicClosedChime` in listening-chime.mts) plays when a
         window ends with nothing heard. Third hallucination discarded during verify
         ("Hvordan er temperaturen på 2. etasje?") — the guard is earning its keep.
17. [x] Audio-skip defaults DONE 2026-07-28 (live, real PE): fresh-wake transcripts clean —
         no wake-sound artifacts with `initial_audio_skip` 0 (three wake turns checked);
         follow-up answer "New York, ja." transcribed with the first word intact
         (`followup_audio_skip` default 150 ms).
18. [x] Bring! with real credentials: add / remove / read items; SSO-account gotcha message
         (items 18–21: console `ask` is fine, no satellite needed)
19. [x] Web search DONE 2026-07-28 (live, real PE): `openai` ✓ (specific query answered
         with sources in ~17 s; a broad "all today's news" query hit the 30 s
         REQUEST_TIMEOUT_MS and failed gracefully — SEARCH_FAILED to the model, spoken
         apology, no hang; decision: keep 30 s, voice users won't wait longer);
         `brave` ✓ (real key, result in ~1 s, snippets summarized by the agent);
         `disabled` ✓ (explicit "søk på nett" request → no tool call, agent says it
         can't search). UNTRUSTED WEB CONTENT wrapper observed on both backends.
20. [x] Gemini live provider DONE 2026-07-28 (live, real PE, real key): provider rebuilt
         on save, greeting + follow-up + get_local_time + full smart-home chain
         (get_zones/get_device_types in parallel → get_devices → set_device_capability,
         office light off) all worked. **Latency better than OpenAI** per the owner.
         Fixed during the test: Gemini emits no speech-start with automatic VAD, so the
         PE LED sat on "waiting" all turn — the provider now emits `speech` on the first
         input-transcription delta (gemini-live-provider.mts, `speechSignaled`). Caveat:
         those deltas lag, so the listening phase renders short; optional post-release
         polish would be local energy VAD (SimpleVad) inside the provider for an
         immediate signal.
21. [x] Feature-gate flips besides weather (verified both ways 2026-07-19): web search,
         timers, Bring!, Music Assistant on/off → provider restarts, tool list changes
22. [x] Budget-meter verdict (green/amber/red) vs `local_llm_num_ctx` — closed together
         with item 36 (Ollama).
23. [x] Flow-card run-listeners from the console DONE 2026-07-30 (emulator console,
         scripted, real PE at 192.168.0.50, 14/14 checks): `and is-muted` false→true→false
         via `press volume_mute`; timer cards — `start-timer` ⚡ timer-started with tokens,
         `timer-is-running` true while counting, ⚡ timer-finished at zero (rang the real
         PE — note: after the emulator exits nothing can cancel the ring; the PE button
         stops it), `cancel-timer` ⚡ timer-cancelled, and starting a new timer over a
         ringing one fires timer-cancelled for the old first (replace semantics, as
         designed); `ask-agent-output-as-text` returned `{"ai-output":"The capital of
         France is Paris."}` tokens; `speak-text` TTS played audibly on the PE. Gotcha
         (emulator-only, already documented in emulator/README): on this multi-adapter
         machine the auto-detected playback host was wrong — first speak-text was never
         fetched; pinning `HE_HOST_IP=192.168.0.58` in settings.json → `env` fixed it
         ([EMU-AUDIO][SERVE] line is the tell). (TR `button-pressed` already verified in
         a real flow 2026-07-19)
24. [x] Emulator `discover` finds and correctly types PE vs Nabu Casa vs TR
         DONE 2026-07-30 (emulator console, real LAN): factory Nabu Casa PE
         (192.168.0.50) → 'pe' with the already-in-settings.json dedup flag; TR
         (192.168.0.56, "3RSPK-…") → 'tr' across multiple scans; Calex ESP8266
         plugs correctly never listed addable. The custom-firmware PE
         (192.168.0.52) has Noise encryption enabled — discover finds it via
         mDNS and correctly refuses the plaintext probe ("encrypted API is not
         supported", listed not-addable, documented emulator limitation); a
         direct keyed probe (real client + the device's PSK, Noise path) typed
         it 'pe' with 1/1/1 voice capabilities, so both PE firmware variants
         are verified in the same sniff branch. Fixed along the way: (1)
         `Logger.error()` appended a literal "null" to every detail-less error
         line (homey.error renders all args); (2) stale emulator README claim
         that the plaintext-only probe is "same as the app" (app has Noise
         since M2); (3) `ensureMicClosedChime` was never stubbed in the device
         harness tests — the real one writes to /userdata/audio, so the
         empty-transcript test passed or failed depending on whether that dir
         exists on the host (it started existing after this session's emulator
         runs). Now stubbed like its sibling and the test asserts the chime
         playback (second run_start/run_end pair) deterministically.
25. [x] **Upgrade path**: install this build over a real 1.4.0 — devices survive without
         re-pairing, new settings keys get sane defaults (especially what
         `initial_audio_skip` ends up as on *existing* devices after the 350→0 default
         change), provider still connects
26. [x] XiaoZhi pairing through Homey's real pairing UI DONE 2026-07-30 (owner tested
         on the real Homey before this session).
27. [x] Device tile: active timer name + time remaining shown; volume/mute changes from
         the Homey UI reach the satellite DONE 2026-07-30 (emulator, real factory PE at
         192.168.0.50): tile capabilities correct at every step — start-timer 65 "pasta"
         → timer_active=true / timer_name="pasta" / timer_remaining=62, counting down on
         the 1 s tick (57 five seconds later), cancel → false/0/"" — these are the values
         the tile binds to. Homey-UI direction verified by invoking the real capability
         listeners (`press`): volume_set 0.2 vs 0.7 audibly different on the PE
         (speak-text A/B), volume_mute true showed the PE muted (red) and false restored
         it; original volume restored after the test. Note: volume_set read null at boot
         (PE hadn't echoed its volume state yet) — cosmetic, values flow once set.
28. [x] Audio-file TTL cleanup on the Homey (serving/playback already verified implicitly)
29. [x] Internet drop mid-session (cloud providers) recovers DONE 2026-07-31 (emulator +
         real PE, REAL router-WAN pulls, scripted probe-every-25s harness — two runs).
         **Run 1 caught a real bug:** during the outage everything failed gracefully
         (clean errors, no crash, ESP + OpenAI reconnect campaigns with backoff), and the
         websocket + session reconfiguration recovered on their own — but every post-restore
         flow-card TEXT request timed out forever. Root cause: `sendSessionUpdate()` (the
         reconnect path) puts the SERVER in audio mode but didn't resync the client-side
         `outputMode` cache, so `setOutputMode("text")`'s early-return no-opped and the
         audio-mode session never sends the `text.done` the request waits on. Voice turns
         were unaffected. Fix: one-line cache resync in sendSessionUpdate
         (openai-realtime-agent.mts) + 2 regression tests
         (tests/openai-agent-output-mode.test.mts). **Run 2 (with fix): PASS** — probes
         failed cleanly during the pull, first probe after restore succeeded (t+189s,
         ~outage end + one backoff), RECOVERY CONFIRMED. (Satellite power-cycle side was
         already verified 2026-07-19.)
30. [x] **Build the custom-pipeline matrix-runner** DONE 2026-07-31:
         `emulator/matrix-runner.mts` + `matrix.example.json` (documented in
         emulator/README.md, incl. the docker one-liners for every LAN service). Reuses
         the stage-tester client builders (now exported), so it tests exactly what the
         settings Test buttons build. STT = reference clip (emulator/recordings/
         matrix-ref-en.wav, generated via OpenAI TTS) + word-score diff, streaming path
         included where the backend has one; LLM = plain round + two-round tool-call trip
         (call get_current_time, then use the fed-back result); TTS = fixed sentence +
         duration sanity + WAV saved to emulator/matrix-out/ for listening. Full run:
         **12/12 passed**. Spoken turns ran as four family combos through the emulator
         (`mic matrix-ref-en` — full VAD→STT→LLM→TTS→satellite turns on the real PE):
         A whisper/ollama/piper, B wyoming/ollama-v1/wyoming, C speaches/mistral/kokoro,
         D mistral-batch/mistral/kokoro — all with correct transcripts and tool
         execution. Gotcha found: `gpt-oss` crashes Ollama's llama-server on Windows
         (0xc0000409) — matrix uses qwen2.5:3b. One test-harness artifact: back-to-back
         mic turns in ONE session can interfere with the previous turn's still-playing
         announce — inject into a fresh/quiet session.
31. [x] STT: Whisper HTTP — matrix 2026-07-31 (onerahmet ASR docker :9000), 100%
         transcript + spoken turn (family A)
32. [x] STT: Wyoming faster-whisper — matrix 2026-07-31 (:10300 docker), 100% + spoken
         turn (family B)
33. [x] STT: Mistral Voxtral (batch) — matrix 2026-07-31, 92% (wrote "5" for "five") +
         spoken turn (family D)
34. [x] STT: Mistral Voxtral Realtime (streaming) — live-verified 2026-07-19; matrix
         2026-07-31 re-verified batch AND streaming paths, both 100%
35. [x] STT: OpenAI-compat — matrix 2026-07-31 (speaches :8000, faster-whisper-small),
         100% + spoken turn (family C)
36. [x] LLM: Ollama — matrix 2026-07-31 (qwen2.5:3b): plain + tool round-trip ok, and
         `local_llm_num_ctx` verified ACTUALLY APPLIED (`ollama ps` CONTEXT column =
         8192 after a chat; drops to Ollama's 4096 default via the /v1 endpoint, which
         has no num_ctx — expected). Closes the budget-meter half of item 22.
37. [x] LLM: LM Studio — live-verified 2026-07-19, model auto-pick from `/v1/models` OK
38. [x] LLM: Mistral — live-verified 2026-07-19; matrix 2026-07-31 re-verified tool trip
39. [x] LLM: OpenAI-compat — matrix 2026-07-31 (Ollama's /v1 endpoint as the compat
         server): plain + tool round-trip ok + spoken turn (family B)
40. [x] TTS: Piper HTTP — matrix 2026-07-31 (artibex/piper-http :5000), 4.0 s audio +
         spoken turn (family A)
41. [x] TTS: Wyoming Piper — matrix 2026-07-31 (:10200 docker), 2.6 s audio + spoken
         turn (family B)
42. [x] TTS: Mistral Voxtral TTS — live-verified 2026-07-19; matrix 2026-07-31
         re-verified (settings-page check closed under item 46)
43. [x] TTS: OpenAI-compat — matrix 2026-07-31 (kokoro-fastapi :8880, free-text voice
         override `af_bella` honored), 3.0 s audio + spoken turn (families C/D)
44. [x] Cross-cutting: streaming-STT batch fallback DONE 2026-07-31 (decision: covered).
         The fallback seam (stream.finish() throws → one batch transcribe of the
         VAD-kept clip) is deterministic in local-pipeline-provider.runAudioTurn and
         unit-tested ("falls back to batch STT when the streaming session fails");
         both the streaming and batch paths were verified live against real Mistral in
         the matrix. A literal mid-utterance socket kill needs network fault injection
         (admin firewall) — not reproducible in this environment, and the failure mode
         it would exercise is exactly the unit-tested catch.
45. [x] Cross-cutting: kill a stage mid-turn DONE 2026-07-31 (live, emulator + real PE,
         5/5): baseline turn ok → `docker stop matrix-piper-http` → turn errors
         gracefully (no crash/hang) → container restarted → next turn recovers →
         LLM port flipped to a dead 11435 → ask errors gracefully → port restored →
         "RECOVERED". Emulator process stayed healthy throughout.
46. [x] Cross-cutting: settings page DONE 2026-07-31 (real page in Chrome via the
         emulator's :8060 hosting): MIRRORED_INPUTS verified in BOTH directions with
         real keystrokes (typed into mistral_model_rt → pipeline field followed;
         typed into the pipeline field → _rt followed; load-sync also confirmed), and
         the Voxtral voice dropdown listed 30 live voices fetched with the saved key —
         every value a UUID ("Paul - Neutral (EN-US)" …), zero preset names. Piper
         backend correctly falls back to "Piper server voice" when the server has no
         /voices endpoint.
47. [x] README screenshots refreshed DONE 2026-07-26 — the old ones predated the
         provider-choice settings redesign. Replaced with five current per-section
         screenshots under `.resources/settings_*.png`.

---

## 13. libflacjs decode corruption in the emulator (2026-08-04)

`tests/emulator-recordings.test.mts` → *"decodes a FLAC clip back to 16 kHz mono PCM"* failed on
a new machine (macOS, Node 24.19.0, clean reinstall): a 200 ms clip decoded to 600–800 ms, with
repeated `FLAC__STREAM_DECODER_ERROR_STATUS_LOST_SYNC` in the log. Surfaced alongside the npm 12
`allow-git` install fix (`.npmrc`, commit `c0378af`) but **unrelated to it** — `package-lock.json`
was untouched and `libflacjs` was the pinned `5.4.0` in both places.

**Root cause — a latent bug in libflacjs 5.4.0, not in our code.** `Decoder._createReadFunc()`
(`node_modules/libflacjs/src/decoder.ts:360`) sizes the stream from
`binData.buffer.byteLength` — the whole **enclosing** `ArrayBuffer` — instead of the view's
`byteLength`. `subarray()` clamps the buffer it hands back, so the data is never wrong, but the
callback keeps reporting the inflated `readDataLength` to libFLAC. libFLAC then parses stale
**emscripten-heap** bytes as extra frames, re-decoding its own leftover buffer.

`readFileSync` returns a pooled buffer for any file under `Buffer.poolSize / 2`, so a small clip
is a *view* into a shared pool rather than its own ArrayBuffer — which is what trips the bug. The
severity scales with the pool size, and **that** is what changed between machines:

| enclosing ArrayBuffer | LOST_SYNC | decoded | test |
|---|---|---|---|
| 8192 — Node ≤22 (the old Windows box) | 1 | 4800 samples (correct) | **passes** |
| 65536 — Node 24 (`Buffer.poolSize` was raised) | 4 | 19200 samples (4×) | **fails** |
| exact-size buffer (the fix) | 0 | 4800 samples | passes, silent |

So the bug was **always present on Windows too** — the owner confirmed seeing `LOST_SYNC` there —
but the smaller over-read let the decoder resync before it produced extra frames, so the
assertion stayed green and the error line was written off as noise. Node 24's larger pool
escalated it from "logs noise, still works" to "silently returns 4× the audio".

Ruled out along the way (all were wrong guesses in the first pass): macOS/clean-reinstall, the
npm 12 blocked-postinstall-scripts gate, a stale shared `Flac` singleton, residual JS pool
garbage (trailing bytes 0x00/0xFF/0x41 all behaved identically — it is fully deterministic, not
luck), and any fault in `pcmToFlacBuffer` (the **encoder** is fine; its output decodes perfectly
from an exact-size buffer).

**Fix:** `emulator/runtime/recordings.mts` now passes `new Uint8Array(flacData)` — a real copy
into an exactly-sized ArrayBuffer — instead of a zero-copy view. One line, with a comment warning
against "optimizing" the copy away. Suite green: 686 passed / 15 skipped, and the decoder is now
completely silent (0 errors, on both pool sizes).

**Blast radius: emulator only.** `new Decoder` appears in exactly one place —
`emulator/runtime/recordings.mts` (the console `mic` clip-injection command). Shipped `src/` code
only ever *encodes* FLAC (`src/helpers/audio-encoders.mts` uses `Encoder`), so real device audio
was never affected. Worth remembering if FLAC decoding is ever added to the app itself: the
underlying libflacjs bug is still there, and any `Buffer` from `readFileSync` will be pooled.

**Also worth knowing:** `npm test` has never run in CI — the GitHub workflows only run
`homey app validate`. This test's only prior verification was a local run on the owner's machine,
which is why a latent failure could sit unnoticed.

---

## 14. VoiceAssistantEvent payloads + the silent-wake deadlock (2026-08-06, live-verified 2026-08-09)

**Fix 1 — payloads were silently dropped on the wire.** `stt_end`, `pipeline_error`,
`intent_progress` and `stt_vad_end` built their payload as a spread property (`{ text }`), which
`VoiceAssistantEventResponse` has no field for — protobufjs drops unknown fields silently, so the
device received the bare event type all along and the firmware bailed with *"No text in STT_END
event"*. They now use the repeated `data` name/value field like `intent_end`/`tts_start`/`tts_end`
already did, and `vaEvent()` **only** accepts that array so the trap can't come back
(`tests/esp-voice-assistant-events.test.mts` asserts on the encoded bytes). Same family of bug as
the `mediaId` vs `media_id` gotcha in §1 — with protobufjs, a wrong field name is not an error,
it's silence.

**Fix 2 — a turn nobody spoke into never closed, and took the satellite deaf with it.** Server VAD
only reports the END of speech, so total silence produced no event at all: the mic stayed open
indefinitely, and because a turn in `listening` arms the duplicate-wake guard, **every later wake
was dropped until the device reconnected**. A 15 s no-speech timeout (Home Assistant's own
`VoiceCommandSegmenter` value) now closes the turn the way an empty transcript does — STT_END /
RUN_END plus the mic-closed cue, no error event. Cleared as soon as VAD hears speech, so a slow
talker is unaffected.

**Live verification on a real PE, 2026-08-09** (Norwegian, `homey app run --remote`) — all three
cases clean:

- *Normal turn* — `STT_END` carries its text ("Speech recognised as: 'Hvor mye er klokka?'");
  `intent_progress` (×9) and `stt_vad_end` arrive without warnings. The firmware's `on_stt_end`
  trigger fired for the first time ever, with no ill effect.
- *No API key* — `on_error` received a real payload (`Error: agent-not-connected - API key is
  missing.`) instead of empty strings, played the pre-recorded FLAC, returned to IDLE.
- *Wake then total silence* — mic opened 23:39:30, `STT_END` at 23:39:45 (the 15 s timeout; **no**
  `stt_vad_end` anywhere in the turn), mic-closed chime, RUN_END, no error event. The next wake
  2 s later ran a full turn end to end — the deaf-until-reconnect regression is gone.

**Three log artifacts that look like bugs and are not** — check here before re-investigating:

- `No text in TTS_START event` — deliberate on the announce path. `voice-assistant-device.mts:434`
  sends a text-less `tts_start()` **so the firmware discards it**; the firmware's own announcement
  handler fires `tts_start_trigger_` at playback start. Sending text as well double-fired the
  replying phase (and was the prime suspect in the 2026-07-02 wake-word death). In-band turns take
  the other branch at `:558` and *do* pass the text — nothing else fires the trigger there.
- `No url in TTS_END event` — likewise deliberate on the announce path (`:475`): the FLAC already
  went over as an announcement. Only the in-band path sends `tts_end(url)`.
- A **doubled** `run_start … run_end` bracket around an error or a chime — `playUrl()` opens its
  own bracket (`:1256-1265`) after the error bracket at `:321-323`. Two brackets, two intents.

**Minor, not fixed:** the pre-recorded sounds are fetched from `raw.githubusercontent`
(`sound-urls.mts:12`), so the error clip started ~4 s after the event where LAN-served replies
start in well under a second. Only affects error paths.

**Related, verified in the same session:** the spurious-retry window fix (clock measured
mic-open → mic-**close** rather than → transcript arrival). A hesitant utterance held the mic open
8 s — 3 s of hesitation before VAD speech-start, transcript 5 s later — and produced exactly one
run_start/run_end pair and one reply. The old arrival-based clock would have called that spurious
and fired a retry.

---

## 15. Expected configuration errors no longer reach Sentry (2026-08-09)

Found while live-testing the None-TTS backend. Using the *Say* flow card with
`local_tts_provider: 'none'` throws by design — but the throw was being filed as an **app crash**:

```
speakText → LocalPipelineProvider.textToSpeech (throws)
          → driver run-listener catch  (voice-assistant-driver.mts:112)
          → this.logger.error('Error speaking text:', err)
          → Logger.error → reportError   (logger.mts:166, UNCONDITIONAL)
          → homeyLog.captureException    → Sentry
```

`Logger.error()` reports **every** error it is handed, so a deliberate user setting generated a
Sentry event for every user who tried the combination. The per-fingerprint 1 h cooldown
(`logger.mts`) capped the volume — in the live log the identical second failure 0.54 s later
produced no `captureException` line — but it did not stop the first.

**Fix — flag the error, not the call site.** `expectedError(message)` in `logger.mts` builds an
Error carrying `expected = true`; `reportError()` bails at the top on `isExpectedError(error)`.
Chosen over passing a flag through `logger.error()` because it leaves the ~40 existing call sites
untouched and travels with the error through any number of catch/rethrow layers. The local log,
the `[err]` output and the Flow-editor message are all unaffected — only Sentry is skipped.

`local-pipeline-provider.mts` now throws the None-TTS error via `expectedError()`. That is the
only site changed: the None-**LLM** stage does not throw at all (it emits `response.done` /
`text.done` and lets the device close the run), and no other `noOp` throw exists.

Tests: `tests/logger-sentry-throttle.test.mts` gains two cases (an expected error is not reported
but *is* still logged via `homey.error`; an ordinary error raised right after one still is), and
`tests/local-pipeline-provider.test.mts` asserts the Say-card rejection carries the marker. Suite
green — 752 passed / 15 skipped; build and lint clean.

**If you add another "you switched this off / you haven't configured this" throw, use
`expectedError()`** — the default path reports it to Sentry.
---

## 16. Debug tools: last seen devices + "what did I just say?" (2026-08-10)

The settings page's **Logging** section became **Debug** and now holds three tools. Both new ones
exist to answer a support question the logs alone could not:

**Last seen devices** — *"why doesn't my satellite show up when I pair?"* Homey runs the
`esphome` discovery strategy continuously (it is what keeps paired devices' IPs current), but
nothing looked at its results outside a pair session. `src/helpers/discovery-watcher.mts` polls
the strategy from the app every 60 s, records every result in `src/helpers/seen-devices.mts`
(bounded at 30, oldest un-paired evicted first, paired devices never evicted) and probes devices
it has never probed — 3 per round, one at a time, never encrypted ones (the handshake cannot
succeed without the key) and never paired ones (their live connection is the better signal and
the probe would spend one of the satellite's API slots). The registry stores exactly the fields
pairing matches on (`friendly_name` / service name / host / address:port / `mac` / `platform` /
version / project / `api_encryption`), so the list explains a non-appearing device instead of
just omitting it. The star means "answered the probe and has the voice-assistant capabilities" —
the same test pairing applies.

To keep that promise literally true, the probe itself was extracted to
`src/voice_assistant/esp-probe.mts` and **both** driver probe paths now use it
(`checkVoiceCapabilities` and `probeManualEntry` shrank from ~90 promise-wrapped lines each to a
status switch). Its statuses map 1:1 onto the pair-view reasons that already existed
(`not_a_match`, `requires_encryption`, `unreachable`, `timeout`, and the Noise codes), so pairing
behaviour is unchanged. `createClient` is a test seam — `tests/esp-probe.test.mts` drives it with
a fake emitter.

**What did I just say?** — *"is the microphone bad, or is speech-to-text bad?"* The `rx_*` capture
already existed but was emulator-only and played back immediately. It is now also driven by the
`debug_audio_enabled` global setting (off by default) and, when on, the FLAC is registered in
`src/helpers/recording-registry.mts` instead: kept for `debug_audio_retention_min` (5–60 min,
last 20), labelled with the transcript STT produced, and playable either from the Debug page
("Play on device" — the settings webview can't play the plain-http LAN URL itself) or by voice
through the gated `play_voice_recording` tool. The tool **awaits** playback (each clip's own
length + 400 ms), so the model's spoken reply lands after the audio instead of over it, and each
device registers a player callback in the registry so neither the tool nor the API has to look
devices up through the driver.

Two bugs found on the way:
- `saveInputBuffer()` hardcoded a 24 kHz FLAC header, so a capture from a 16 kHz-input provider
  (Gemini, and the local pipeline) played back 1.5× too fast. It now uses
  `provider.inputSampleRate`.
- Registry eviction popped the entry before calling `remove()`, which looks the entry up to find
  its path — so the file of an evicted recording was never unlinked. Caught by
  `tests/recording-registry.test.mts`.

New tests: `esp-probe`, `seen-devices`, `discovery-watcher`, `recording-registry`, `debug-api`,
plus a `play_voice_recording` case in `feature-gates`. Suite: 802 passed / 15 skipped.

**Follow-up (2026-08-10): the `play_voice_recording` tool was removed again.** Tested on the real
device, asking *"hva var det jeg akkurat sa?"* plays back exactly that question — the recording of
the turn that triggered the tool is the newest one, so the answer is always the question itself.
The Debug page is where you actually compare audio against the transcript, and it is enough. Gone
with it: `RECORDING_TOOL_NAMES`, `recordingPlaybackActive`, `refreshRecordingPlaybackTools()`,
`isRecordingPlaybackActive()`, `setRecordingDeviceId()` and the `debug_audio_enabled` provider
restart in `handleSettingsChange`. The registry, the player callback and `playRecordings()` stay —
they serve `POST /play-recording`. The `feature-gates` case now asserts the tool is *never*
registered, even with `debug_audio_enabled` on.

---

## 17. Audio URLs on the Docker bridge + the unsubscribed device events (2026-08-10)

Both came out of the **ReSpeaker tester's second report** (forum post #60, 2026-08-10, full app +
ESPHome logs), and neither turned out to be ReSpeaker-specific or caused by the custom pipeline he
suspected. Landed on the `claude/respeaker-audio-clarity` branch, merged to `dev` as `8dc5291`.

**Audio URLs could advertise the app container's Docker address** (`fbb5cf5`). The device fetched
`http://172.17.0.2/app/no.arvebjoe.ai-voice-assistant/userdata/audio/tx_….flac` and got
`esp-tls: [sock=58] select() timeout` → `ESP_ERR_HTTP_CONNECT`; a later run of the *same* device on
the *same* app used `192.168.1.107` and played fine. Cause: `getLanIP()` returned on the first
non-internal IPv4 whose interface name matched `/^(eth|en|enx)/i`, and the app container's veth is
also `eth0` — so it short-circuited before the real LAN interface was ever considered. Which
interface enumerates first is a startup race, hence the intermittency, and it affected **every
driver**.

Fix: take the advertised host from the **local end of the TCP socket the satellite is already
connected on** (`socket.localAddress` → `WebServer.reportReachableIp()`), which is routable back by
construction — no heuristics. Shared across devices (they all sit on Homey's LAN) and re-reported on
every reconnect, so a DHCP lease change corrects itself. Interface sniffing stays as the
no-device-connected fallback and now *demotes* container-bridge-shaped addresses (172.17–172.31)
instead of returning them; if every candidate looks like a bridge it still returns one, because
Homey could genuinely sit on 172.16/12 and a wrong-but-plausible address beats `127.0.0.1`, which is
wrong for certain. Tests: `tests/webserver-lan-ip.test.mts`.

**Follow-up 2026-08-11 — `socket.localAddress` is not enough either.** A `reply-audio-ready` URL came
out as `http://172.17.0.2/…` again. Both sources this fix relied on can see *only* the bridge:
where the app container is NATed, our end of the device socket **is** `172.17.0.2` (the satellite
still reaches Homey on its LAN address, after masquerading), and the interface list inside the
container has nothing else in it to sniff. Neither heuristic can derive an address the container
cannot see. Fix: **ask Homey** — `homey.cloud.getLocalAddress()` returns `"<ip>:<port>"` and needs no
permission (`homey-lib`'s permission list has no cloud entry). Fetched in `WebServer.init()` behind a
5 s timeout so a hanging manager can't stall app boot, cached 10 min (60 s backoff on failure) and
refreshed lazily from `getLanIP()`. Precedence is now: `HE_HOST_IP` → device-reported address **when
it is not bridge-shaped** (still routable by construction on an ordinary LAN, and it beats Homey's
answer if Homey is dual-homed) → Homey's own local address → interface sniffing → any bridge-shaped
address as the last resort. A bridge-shaped report is recorded and logged as NATed but no longer
wins. Port is kept in the URL only when it isn't 80.

**Worth recognising in future reports:** an unreachable announce URL puts the satellite in a ~2 s
retry loop — the firmware's hardcoded `start_playback_timeout_` ends the announce as "finished", our
`announce_finished` handler dequeues the next segment, repeat. On the ReSpeaker that surfaced as
endless `Beam lock released` / `activate_stop_word_once is already running` churn, which looks like a
firmware fault and is not one.

**We never subscribed to the device's Home Assistant events** (`9c478fc`). The client sent
`SubscribeVoiceAssistantRequest` + `SubscribeStatesRequest` but never
`SubscribeHomeassistantServicesRequest` (id 34), so the firmware discarded every event a device fired
at us with `client has not subscribed to actions (yet)` — on the ReSpeaker that is `esphome.tts_uri`,
`esphome.stt_text` and `esphome.wake_word_detected`, several lines per turn. Nothing was broken by
it (we consume none of them); subscribing is log-noise reduction plus the opening for a real
wake-word-detected signal. `HomeassistantServiceResponse` is now logged; note its data is
`{key, value}`, **not** the `{name, value}` shape `VoiceAssistantEventResponse.data` uses. Kept off
the discovery-probe path like the other subscribes. Tests:
`tests/esp-homeassistant-services.test.mts`.

The third item from that report — `No text in STT_END event` — needed no work: it was already fixed
on `dev` by `198ce16` (§14) and his log came from a `main` build.

## 18. `object_id` is gone from the ESPHome entity list — API 1.14 (2026-08-10)

Started as the TODO's cosmetic "consider advertising a newer API version" (current firmware logs
`'ai-voice-assistant' using outdated API 1.6, update to 1.14+`) and turned out to be a **live bug in
the opposite direction**: bumping the number is the *safe* half, and the thing that number gates was
about to break us regardless.

**What the client's advertised version actually gates.** Exactly one server behaviour that concerns
us — `object_id` on every `ListEntities*Response`. Verified by reading every
`client_supports_api_version` call site in ESPHome (`api_connection.cpp`/`.h`, tags 2025.7.0 →
2026.7.4 → dev): the only others are the 24-vs-34 initial batch size and BLE 16/32-bit UUIDs
(`bluetooth_proxy.h`, 1.12), neither of which touches us. Everything else that moved between 1.6 and
1.14 (1.7 `legacy_data`→`data`, 1.9 BT flags, 1.10 voice-assistant feature flags, 1.11 media-player
feature flags, 1.13 climate) is **client-side interpretation** keyed on the *server's* version, and
we already read the modern fields (`voiceAssistantFeatureFlags`, field 17).

**The timeline that matters:**

| ESPHome | advertises | sends `object_id`? |
|---|---|---|
| ≤ 2025.12 | 1.10–1.13 | always |
| 2026.1.0 – 2026.6.x | 1.14 | **only to clients advertising < 1.14** |
| 2026.7.0+ | 1.14 | **never, to anyone** — the backward-compat block was deleted |

The field is declared `(force) = true`, so it still arrives on the wire **as an empty string**. Every
`if (message.objectId && message.key)` guard therefore goes quietly false, `entityKeys` stays empty,
and **volume, mute and the media-player key all go dead** with no error anywhere. Nobody had hit it
yet only because stock PE firmware is still 26.6.0 (ESPHome 2026.6.x, `min_version: 2026.5.0`) — but
2026.7.4 is the current release, so anyone self-compiling, including ReSpeaker/M5Stack/XiaoZhi users
following our own `.esp_home/INSTALL.md` and its `pip install -U esphome`, gets it today. It also
means advertising 1.6 was what *kept* the field flowing on 2026.1–2026.6: bumping to 1.14 without
the derivation would have been a regression on every currently-shipping PE.

**Fix:** `src/voice_assistant/entity-object-id.mts` reconstructs the id the way the firmware does —
`to_sanitized_char(to_snake_case_char(c))` per **UTF-8 byte** of the entity name, from
`EntityBase::write_object_id_to()` (`esphome/core/entity_base.cpp` + `helpers.h`), truncated at 127
bytes. Per byte, not per character: the firmware turns each byte of `温度` into its own `_` (six),
where Home Assistant's `aioesphomeapi` iterates Python characters and produces two — the firmware is
the authority on what it *would* have sent. `resolveObjectId()` in the client uses what the device
sent and derives only when it is empty, so one code path is correct on every firmware from 2024 to
dev and no version negotiation is involved. Then the Hello bump to 1.14, which is now free.

Reproduces every id we key on: `Mute` → `mute`, `Media Player` → `media_player`, ReSpeaker's
`Microphone Mute` → `microphone_mute`, M5Stack's `Mute Microphone` → `mute_microphone` — so
`scoreMuteCandidate` and the `includes('volume')` number match are unchanged. Two deliberate
non-generalisations: **no device-name fallback** for entities declared `name: None` (the firmware
would use the device/sub-device name there, which no lookup in this client keys on, and
`DeviceInfoResponse` arrives 500 ms *after* the entity list anyway), and the **primary media player
is now keyed on the entity key alone** so a nameless media player still plays. Tests:
`tests/entity-object-id.test.mts`.

**Also found while diffing our vendored `api.proto` against 2026.7.4, no action needed:**
`ConnectRequest` was renamed `AuthenticationRequest` (ids 3/4 deprecated and reserved; message 3
lands in `default: break;`, i.e. silently ignored — the existing handshake handling and the CLAUDE.md
note are correct as written). `VoiceAssistantAudio` gained `data2 = 3`, a **second microphone
channel** for dual-mic configs, not a continuation of `data` — ignoring it is right and it must not
be concatenated. `VoiceAssistantConfigurationRequest` gained `external_wake_words` (client→server,
optional). No renumbering or removals affecting anything we send or read.

## 19. A deleted device kept receiving events from its provider (portal crash, 2026-08-15)

**Crash report from the Homey developer portal**, on an M5Stack AtomS3R running the Gemini
provider:

```
TypeError: Cannot read properties of null (reading 'abort')
    at abortCurrentTurn (voice-assistant-device.mjs:978)
    at GeminiLiveProvider.<anonymous> (voice-assistant-device.mjs:877)
    at WebSocket.onclose (gemini-live-provider.mjs:207)
```

**Root cause: `onDeleted()` detached the ESP client's listeners but not the provider's.** It was
already explicit about the ESP side — `this.esp.removeAllListeners()` *"before disconnecting to
prevent any event-triggered actions"* — and `rebuildProvider()` did the same for the provider on a
runtime provider switch. Only the delete path skipped it, and it then nulled `audioOutput`, `esp`
and `provider`. `close()`/`destroy()` merely *asks* the websocket to shut down; the `onclose`
callback fires a tick later and still reached the device's `provider.on('close')` handler, whose
`abortCurrentTurn()` calls `this.audioOutput.abort()` on a null field. Triggered by deleting or
re-pairing a device while its provider socket is open — which the AtomS3R tester had been doing
repeatedly (issue #44).

Nothing about it was Gemini- or driver-specific: no provider self-detaches in `destroy()`, and
`error` / `Healthy` / `Unhealthy` / the audio handlers all pointed at the same dead instance.

**Fix, in two parts.** `onDeleted()` now calls `(this.provider as any).removeAllListeners?.()`
before `destroy()`/`close()`, mirroring the ESP client above it — that is the real fix, since it
stops every late event at the source. Belt-and-braces, a `destroyed` flag set at the top of
`onDeleted()` makes `abortCurrentTurn()` return immediately, so any path that still slips through
is inert rather than throwing; the ESP calls inside it were already dead by then and only survived
because they sit inside a `try`.

**The mock lied, so the bug was untestable.** `tests/mocks/mock-voice-provider.mts` had
`destroy()` call `this.removeAllListeners()` on itself, which no real provider does — that alone
would have made a regression test pass against the broken code. The mock now matches
`GeminiLiveProvider`/`LocalPipelineProvider`. Three tests in
`tests/voice-assistant-device.test.mts` ("teardown — a deleted device must not be reachable from
its transports") cover the late `close`, the full listener detach, and the `abortCurrentTurn`
guard; all three fail against the pre-fix device.

## 20. A dropped Improv BLE link stayed invisible until a read or write failed (2026-08-15)

**From the second portal report** (log ID `6abc4a3e-...`, 2026-08-12; the user's message was
*"Pas de connexion"*). Timeline: peripheral `connected` 13:09:13 → all **three** notification
subscribes fail with `Not Connected` → `refresh()` reads the state fine anyway → `Connected —
state=AwaitingAuthorization` returned 13:09:15.282 → peripheral **`disconnected` 13:09:15.772** →
and 21 seconds later the wizard logged `Awaiting on-device authorization (button press)` and asked
the user to press a button on a link that had been dead the whole time. The write then failed, the
reconnect-once path fired, two 20 s connect attempts timed out — ~70 s wasted, ending in the
Sentry-captured `Lost BLE connection to the device`.

**Root cause:** `isConnected` answered *"did we ever connect, and have we closed it ourselves?"* —
`peripheral !== null && !this.closed` — which is true for a peripheral that has hung up. Nothing
watched for the drop, so it was only ever discovered by a read or write failing.

**Fix.** `isConnected` now also tests `!linkDown && peripheral.isConnected !== false`, so it means
what its name says. `linkDown` is set by `watchForDisconnect()`, which subscribes to the
peripheral's `disconnect` event — Homey's `BlePeripheral` extends `SimpleClass` (an EventEmitter)
and does emit it, but **it is not in `@types/homey`**, so the event is treated as an accelerator,
never the mechanism: `waitFor()`'s poll re-checks `isConnected` every tick before it reads, and a
failed read still fails the wait exactly as before. `provision()` checks the live link on entry —
that is the 21-second window, since the wizard holds the session open while the user types their
credentials — and a `link-down` event ends a wait already in flight. Both paths keep the existing
precedence rule: **a completed wait beats the drop**, because a device hanging up right after
`PROVISIONED` is normal and must not turn a success into a failure.

Deliberately **not** done: treating "all three subscribes failed" as a dead link, which the TODO
entry had proposed. The log disproves it — the state read immediately after those three failures
succeeded, so the link was alive for reads at that moment. The three separate warnings are now one
line (`No notifications available — polling state every Nms`), which reads as the mode it is
instead of three faults.

**Effect on the caller:** the pair handler's reconnect-and-retry (`improv-pair-handlers.mts:278`)
now fires within a poll tick of the drop instead of after the authorization timeout, so the user
gets a retry while still standing at the device.

Tests: `tests/improv-ble-client.test.mts`, *"a link the device drops on its own"* — five cases.
Three fail against the pre-fix client (the session reporting itself connected; `provision()`
emitting the press-the-button prompt on a dead link; a wait in flight not ending until a poll
reads). Two are guards that pass either way on purpose: the poll-only fallback
(`emitsDisconnect: false`, since the event is undocumented) and the expected post-`PROVISIONED`
drop still resolving. `tests/mocks/mock-improv-ble.mts` gained `dropLink()` and an EventEmitter
peripheral to model the device hanging up.

## 21. Verbose logging — the quieted subsystems, on demand (2026-08-15)

**Why.** Four loggers are constructed `disabled: true`: `Voice_Assistant_Device`, `ESP`, `PE` and
`AGENT`. They are precisely the four that say whether the satellite link and the AI engine ever
connected — and precisely the four a user's submitted log does not contain. The second portal
report is the cost of that: a reporter wrote *"Pas de connexion"*, paired his Voice PE **six
times**, and the log he sent proved the ESPHome handshake and playback worked while saying nothing
at all about the agent (§ *Diagnosability* in `TODO.md`). They do mirror into remote syslog at
DEBUG, but that needs a collector almost no reporter runs.

**Shape.** A module-level flag on `Logger`, flipped by `setVerboseLogging()` — not per-instance
state, because loggers are created at import time all over the app and are never registered
anywhere, so one switch is the only thing that can reach them all. `info()` on a quieted logger
now falls through to `write()` when the flag is on. Wired in `app.mts` from the existing
`settingsManager.onGlobals` subscription that already configures remote logging, so it applies on
the initial snapshot (app start) as well as on every save. Setting: `verbose_logging`, off by
default, in Settings → Debug.

Two deliberate choices:

- **The remote-syslog severity does not change.** A quieted logger still emits at DEBUG whether or
  not verbose is on: the severity describes what the logger *is*, and collector-side filters
  depend on it. Verbose only decides whether the line also reaches the app log.
- **Both transitions are announced** through a normal logger (`[LOGGER] Verbose logging ON/OFF …`),
  and only on a real change. Without the OFF line, a reader cannot tell "someone turned it off"
  from "that subsystem stopped saying anything" — which is the same ambiguity that made the
  original report unreadable.

`warn()`/`error()` are untouched, as they always were: `disabled` only ever silenced `info()`.

Tests: `tests/logger-verbose.test.mts` — default-off, on, off again, the announcement on real
changes only, no effect on never-quieted loggers, and warnings still written while off. The suite's
`afterEach` resets the flag, since a leaked module-level `true` would change every later test's
output. README's Debug section (now four tools) and a new troubleshooting entry for
*"the tile says unavailable / Connected: no"* point at it; `README.txt` deliberately untouched.

## 22. The pairing probe was rebooting the satellite — ESPHome's null `active_wake_words` (2026-08-17)

**Report.** A forum follow-up to the *"Voice PE stuck Unavailable despite successful pairing"*
thread, from a reporter who had run the app from source with the `ESP` logger re-enabled. His log
pinned the exact stall — TCP connect OK → Hello OK → `DeviceInfoResponse` OK →
`VoiceAssistantConfigurationRequest` sent → **total silence** → 8 s timeout — and he had bisected
it by firmware age: older firmware paired, 25.12.4 / 26.4.0 / 26.6.0 did not. His diagnosis was
that recent firmware *"only replies to `VoiceAssistantConfigurationRequest` if the client is
subscribed"*, and his fix was to make the probe always subscribe.

**The symptom and the bisection were right; the mechanism was not — and the difference matters.**
ESPHome answers an unsubscribed configuration request in every version we support. Checked against
the real sources (`api_connection.cpp` + generated `api_pb2.{h,cpp}`, tags 2025.7.0 → 2026.7.0):

- **≤ 2025.7.0** — `VoiceAssistantConfigurationResponse.active_wake_words` is a by-value
  `std::vector<std::string>`. An unsubscribed request encodes fine and returns an empty response.
  **Probe works.** This is the "older firmware" the reporter saw succeed.
- **2025.8.0 – 2026.5.0** — the field became `const std::vector<std::string> *`, default **null**.
  The unsubscribed branch of `send_voice_assistant_get_configuration_response_()` sends the
  response *without ever setting it*, and `calculate_size()` then runs
  `this->active_wake_words->empty()` on nullptr. The ESP32 takes a `LoadProhibited` exception and
  **reboots**. The satellite is not ignoring the request — it is crashing on it.
- **2026.6.0+** — fixed upstream by pointing the field at a stack-local empty vector
  (*"send_message encodes synchronously, so this stack local outlives the encode"*).
  **Probe works again.**

So we were rebooting people's satellites: every pair-time `list_devices` probes **everything** mDNS
returns, including already-paired devices, and the discovery watcher probes up to three un-paired
devices a minute. That is a much worse bug than a pairing timeout, and it is the likely engine
behind the original *"paired but stuck Unavailable"* complaint — the device keeps getting knocked
over underneath a working pairing.

**Why we did not take the offered fix.** Subscribing during the probe does avoid the crash, but
ESPHome tracks a **single** voice-assistant API subscriber per device, so probing an already-paired
satellite would re-bind its pipeline to the short-lived probe connection and leave it deaf until it
reconnected. The reporter would not have seen this — it needs a second, already-paired device to
show up. The existing "a discovery probe must NOT subscribe" comment was right and stays.

**Fix (his own third suggestion, and the cheapest).** The probe no longer sends
`VoiceAssistantConfigurationRequest` at all. `DeviceInfoResponse.voice_assistant_feature_flags` is
sent unconditionally, needs no subscription, cannot crash anything, and is non-zero for every voice
satellite — `VoiceAssistant::get_feature_flags()` always ORs in `FEATURE_VOICE_ASSISTANT |
FEATURE_API_AUDIO` when the component is compiled in. `legacy_voice_assistant_version` is accepted
as a fallback for pre-flags firmware. The probe emits `capabilities` straight from
`DeviceInfoResponse`; the real (subscribed) connection still asks for the config, because the
wake-word list is the one thing the response carries that we actually use — and a probe has no use
for it. `esp-probe.mts` and its contract are untouched: same event, same four arguments.

Tests: `tests/esp-probe-no-va-config.test.mts` — the probe never sends the request (nor a
subscribe), settles capabilities from device info, honours the legacy version field, reports a
non-voice ESPHome node as incapable, and the non-probe path still asks.

**Not fixable from our side for affected firmware in general:** any *other* API client that asks an
unsubscribed 2025.8–2026.5 device for its VA configuration will still reboot it. Users on those
builds should update to 2026.6.0+ regardless.

**Device firmware version != ESPHome version (measured, 2026-08-17).** Read off a real Voice PE's
`esphome_version` in Settings -> Debug after flashing each build:

| Voice PE firmware | reports ESPHome | verdict |
|---|---|---|
| 25.12.4 | 2025.12.2 | **affected** |
| 26.4.0  | 2026.3.2  | **affected** |
| 26.6.0  | 2026.6.2  | safe (fixed upstream) |

The PE bundles an ESPHome one to two months older than its own version number, so the affected
range must never be quoted to users in PE-firmware terms. README's troubleshooting entry states the
ESPHome range and points at the Debug tab for the real value.

**Open question the reporter's account does not survive.** He listed 26.6.0 among the firmwares that
failed for him — but 26.6.0 carries ESPHome 2026.6.2, which has the upstream fix and answers an
unsubscribed request harmlessly. On this diagnosis, **old app code + PE 26.6.0 should pair fine**.
That is the falsifiable test separating this explanation from his ("recent firmware only replies
when subscribed", which predicts failure on all three). If old code also fails on 26.6.0, the
null-deref is real but is not the whole story and something else is in play on 2026.6.x.

## 23. "Unavailable" now names the failing link (2026-08-18)

**Why.** A device's availability is `isAgentHealthy && isEspClientHealthy` — **two independent
links behind one word**. The satellite being unreachable and the voice engine never connecting
render identically on the tile. The 2026-08-15 forum report is what that costs: the tester saw
*Unavailable* next to a Debug entry showing his device paired, probed and accessible, and went
after his network — an SSH session, a port check from another host, and a whole Home Assistant Core
install to prove the device worked — for what is most likely a missing or wrong API key.
`missing_api_key` returns before the websocket is even opened, so `open` never fires,
`isAgentHealthy` stays false forever, and the ESP link is perfectly healthy the entire time.
Background: `TODO.md` § *Diagnosability*.

**Shape.** `unavailableReason()` returns the message matching whichever flag is false — engine down
(named, plus "check that engine's API key"), device down (plus "same network as Homey"), or both.
The engine is named with the same label the settings dropdown uses (`ENGINE_LABELS`), resolved from
`currentProviderId`, so it follows a provider switch rather than hardcoding OpenAI. `onInit`'s bare
`setUnavailable()` became *"Connecting to the device and the voice engine…"*, which is what it
actually means at that point.

The `updateAvailable()` guard had to change with it. It only called `setUnavailable()` on a
**true → false edge**, which is correct for a bare call and wrong for one carrying a reason: the
reason can change while the device stays unavailable — satellite returns, engine still down — and
the tile would keep blaming the satellite. Now a `lastUnavailableReason` comparison drives it, so a
*changed* reason is pushed and an unchanged one is not (no repeated writes on a repeated fault).

Tests: `tests/device-availability-reason.test.mts` — both up, each side down alone, both down, the
engine named from the *selected* provider, the reason changing while unavailable, no repeat on an
unchanged reason, and recovery clearing it. Two harness gaps surfaced doing it: the mock SDK device
discarded the `setUnavailable()` message (it now records last + history, which is what makes the
"changes while unavailable" case assertable), and the shared harness's `webServer` had no
`reportReachableIp` — the ESP `Healthy` path calls it, so it was unreachable for any test bringing
the satellite link up.

**Not addressed:** the original report's root cause, which was never established and is not
established by this. This makes the *next* one self-diagnosing.

## 24. The Debug list tells the satellite from the engine (2026-08-18)

The other half of §23: the Debug page's *Last seen devices* showed a single `Connected` row, itself
the AND of the same two links, so the one screen a user is told to check could not answer "which
side is down" either.

`SeenDevice` gained `deviceConnected` / `engineConnected` / `engineName` beside the existing
`available`. **`available` is unchanged** and still drives the star and `recordProbe`'s
accessibility logic — the split is purely additive, so nothing that reads the AND had to move.
`updateAvailable()` pushes all three through `markPaired`, and the page renders two rows in place of
`Connected`, the engine row naming the engine. Both are `null` → *"unknown"* until the device
reports, which is the honest state for an entry that has only ever been seen over mDNS (and for
`markUnpaired`, which clears them alongside `available`).

Tests: the `Debug list carries the two links separately` block in
`tests/device-availability-reason.test.mts` — device up / engine down, the reverse, and both up.

## 25. Hardware verification of the pairing probe and the availability changes (2026-08-18)

The checklist for 98f9629 / a967204 / e5d7b7b (§22, §23, §24), run the same day on the owner's four
satellites — two Voice PE, one ThirdReality, one XiaoZhi. Kept because most of it cannot be re-run
without that hardware, and because two of these were open **questions**, not confirmations.

**The feature-flags question is answered: the TR and the XiaoZhi both report a usable
`voice_assistant_feature_flags`.** Both were deleted from Homey and re-added via the network scan;
both were found, listed and paired without incident. This was the one genuine regression risk in
§22's fix — the probe stopped asking for the voice-assistant configuration and now decides "this is
a voice satellite" from that field (falling back to `legacy_voice_assistant_version`), so a device
reporting 0 for both would have become **unpairable**. It was safe by construction only on ESPHome
(`get_feature_flags()` always ORs in `VOICE_ASSISTANT | API_AUDIO`); the TR is a *Linux*
reimplementation of the API whose bits were read from its source and never observed, and the
XiaoZhi had no doc, no capture and no source reading behind it at all. Both fill the field. **No
device on hand needs the signal widened**, which is what the contingency plan would have been.

**The probe no longer disturbs an already-paired device.** With one device paired and working, a
new pair scan (which re-probes everything mDNS returns, the live device included) ran to completion
with no disruption, and a request to the already-paired device immediately after adding a new one
answered normally. That is the bug 98f9629 fixes and the case **no automated test can reach** — it
needs two physical devices.

**Both availability changes behave on hardware.** §23's reasons name the right side in each state,
including the transition the old true → false edge guard got wrong (device restored, engine still
down → the tile re-blames the engine instead of staying stuck), and §24's split *Device connected* /
*Engine connected* rows in the Debug list read correctly alongside them.

**Two satellites hold simultaneous, independent sessions.** A PE and a TR share the wake word
*"ok nabu"*, so one utterance woke both, and both were asked for a three-question quiz. Each
understood the request and ran its **own** quiz — different questions, at the same time. Everything
downstream of the device is an app-level singleton (`WebServer` audio URLs, `FileHelper`, the
recording registry), and nothing automated runs two turns concurrently, so this is the only evidence
that a second live session does not collide with the first.

**A satellite lost mid-session does not disturb the others, and recovers itself.** The PE was
unplugged **during** the quiz, not while idle; the TR carried its own conversation through to the
end unaffected. Plugging the PE back in — including a ~1 s flap — reconnected without disturbing the
TR, which stayed responsive throughout, and the **PE then behaved normally**, so a session torn down
mid-turn leaves nothing wedged behind it. Run **in both directions** (TR pulled instead, PE
continuing), same result. This is §19's isolation exercised on the live path rather than on delete.

**Not repeated:** PE pairing from scratch, already covered by §22's firmware sweep (25.12.4 /
26.4.0 / 26.6.0, each paired plus a command afterwards).

### The probe cannot reboot the satellite — proved on the wire, 2026-08-19

The reboot question was reopened the next day with a syslog collector on the LAN
(`remote_log_*` pointed at a laptop, level DEBUG, which is enough on its own — the quieted `ESP`
and `Discovery` loggers mirror into remote logging at DEBUG, so **Verbose logging is not needed**).
The intended test — watch a live device's link across a pair scan — turned out not to be runnable
as written, and the reason is worth keeping:

- **An encrypted device is never probed at all.** The paired PE advertises `api_encryption`, so the
  scan logs `… advertises api_encryption — listing without probing` and skips it
  (`voice-assistant-driver.mts:426`). No connection, so no reboot is possible — but also no test.
- **The background watcher would not do it either.** `probeUnknown()` only considers
  `registry.unprobed()` (`discovery-watcher.mts:109`), so a device probed once — even one that
  merely failed as `unreachable` — is off the candidate list forever and never re-probed.
- The pair view's ~8 s re-probe loop only runs while the list is **empty** (Homey retrying
  `list_devices`); it stops as soon as a device is listed, and it stops when the dialog closes.

The answer came from the **second, unencrypted PE** (`093b27`, ESPHome **2026.3.2** = firmware
26.4.0, an *affected* version) as the scan probed it. Its complete conversation:

```
Connected → [TX] HelloRequest → [RX] HelloResponse
            [TX] ConnectRequest
            [TX] ListEntitiesRequest → … → ListEntitiesDoneResponse
            [TX] DeviceInfoRequest   → [RX] DeviceInfoResponse
→ Probed … { status: 'accessible', deviceType: 'pe' }
```

**No `SubscribeVoiceAssistantRequest`, no `VoiceAssistantConfigurationRequest`.** The message whose
null-deref reboots ESPHome 2025.8–2026.5 is never sent, on the firmware that used to crash. That
rules out the *mechanism*, which is a stronger result than any number of "the device seemed fine"
observations — and it is why the uptime check this replaced is gone rather than deferred.

**A coincidence that cost twenty minutes, recorded so it is not re-diagnosed:** the paired PE went
`EHOSTUNREACH` during the same session and it looked like the scan had killed it. It had not — the
device's last `PingResponse` was **2 m 45 s before the scan started**, and its reconnect loop was
already at attempt 3 when the pair session opened. It dropped its own Wi-Fi (different power outlet
from the device being powered on at the time) and needed a manual reboot. Note for the
*Diagnosability* section: the health check reported `Connection is healthy` twice while the device
was already silent, because it measures against its own **sent** ping — only the `Last ping received
110s ago` in the message hinted at the truth.

**Nothing downstream of pairing broke**, confirmed on the paired PE's reconnect at the end of the
same session (it is encrypted, so this also re-exercised the Noise path):

```
Encrypted link established with 'home-assistant-voice-0908d1' (20f83b0908d1)
Voice assistant feature flags: 125 (timers supported)
[RX] VoiceAssistantConfigurationResponse
Wake words: available=[hey_homey, okay_nabu, hey_jarvis, hey_mycroft], active=[okay_nabu], max=1
```

The probe stopped asking for the voice-assistant configuration; the **real** connection still asks
and still gets it, which is where the wake-word list comes from, and timers are still advertised
(`125 & 8`). The write side is fine too — **switching the active wake word was used repeatedly**
throughout this testing.

**The checklist is complete.** The last item — a full turn on the freshly re-paired XiaoZhi, audio
playback included — was run on 2026-08-19 and worked. Every device on hand (2× PE, TR, XiaoZhi) has
now been paired from scratch and driven through a conversation on this code. (The TR's is covered — it ran a whole multi-turn
quiz with playback.)

## 26. Window coverings — blinds, curtains and sunshades (2026-08-16)

`set_device_capability` could only write `onoff`, `dim`, `target_temperature` and `locked`, so every
blind, curtain and awning in the house was read-only to the assistant. The read side already
worked: `DeviceManager.fetchData()` formats *every* capability as `name=value`, so `get_devices` has
always reported `windowcoverings_set=0`, and the classes already showed up in `get_device_types()`.
Only the write path was missing.

**Two capability shapes, both required.** Real catalogs carry both, and supporting only the position
capability leaves state-only devices uncontrollable (the reporter's living-room curtains are exactly
that):

- `windowcoverings_set` — position, 0..1, 1 = fully open. Coerced by the same helper as `dim`
  (`ToolManager.coerceFraction`), including the percentage recovery: a model that passes `50` means
  50%, not "clamp to fully open".
- `windowcoverings_state` — Homey's motor-direction enum `up` / `idle` / `down`. Lower-cased and
  whitelisted; `"open"` is the *user's* word and is deliberately rejected.

The instructions tell the model to prefer `windowcoverings_set` and fall back to
`windowcoverings_state` only on devices that lack it; "stop" maps to `idle`.

**The gotcha worth keeping: a sunshade is inverted in everyday speech.** Homey's convention is
uniform — 1/`up` is open, 0/`down` is closed — but for an awning the position users call "open" is
the one where it is rolled *out* to give shade, which is 0/`down`. Left unstated, the model gets
awnings backwards about half the time while getting blinds right. Every language's instruction
block calls this out explicitly. The same block also warns against over-narrow type-locking: covers
are three separate device classes (`blinds`, `curtain`, `sunshade`), so "close the blinds" type-locked
to `blinds` silently skips the curtains and the awning in the same room.

**`newValue` needed a string branch.** The tool schema's `oneOf` was boolean|number, so a
`windowcoverings_state` write would have been schema-rejected before reaching the handler that
validates it.

Touched: `src/llm/tool-manager.mts` (whitelist, schema enum, `get_assistant_capabilities` summary),
all 12 `src/llm/instructions/agent-instructions.*.mts`, `tests/tool-manager-set-capability.test.mts`
(+2 cases), `tests/mocks/mock-device-manager.mts` (a position-only blind and a state-only curtain in
Office, plus the two new types in the hardcoded `deviceTypes` list — `tests/device-manager.test.mts`
count assertions follow), `emulator/settings.example.json` (curtain + awning, and the pre-existing
blind's class corrected from `windowcoverings` to `blinds`), README.md. `README.txt` untouched.

**Cost.** No new tool, so this is enum entries plus ~10 instruction lines — but it rides the
always-on `smart` feature, so it raises the context floor for everyone with no gate to turn it off.
Roughly +300 tokens for English and +500-600 for Russian/Korean (the same chars-per-token divisors
the settings budget meter uses). Judged worth it: the inversion note is most of the block, and
without it the feature is wrong half the time on awnings.
