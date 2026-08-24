import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks (hoisted) must be registered before the harness imports the device. ---
vi.mock('homey', () => import('./mocks/mock-homey-sdk.mjs'));
vi.mock('../src/voice_assistant/esp-voice-assistant-client.mjs', () => import('./mocks/mock-esp-client.mjs'));
vi.mock('../src/llm/voice-provider-factory.mjs', () => import('./mocks/mock-voice-provider.mjs'));
vi.mock('../src/helpers/audio-encoders.mjs', () => ({
    pcmToFlacBuffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
    pcmToMp3Buffer: async (b: any) => (Buffer.isBuffer(b) ? b : Buffer.from(b)),
}));
// Keep the pure PCM helpers real; only stub the /userdata-writing ones so tests
// never touch the filesystem and the reopen path still carries the chime URL.
// Both ensure* helpers must be stubbed: the real ones only resolve when
// /userdata/audio exists on the host, which made chime-dependent assertions
// pass or fail depending on the machine.
vi.mock('../src/helpers/listening-chime.mjs', async (importOriginal) => ({
    ...(await importOriginal() as object),
    ensureListeningChime: async () => 'listening_chime.flac',
    ensureMicClosedChime: async () => 'mic_closed_chime.flac',
}));
// Same reason: the real one fetches the clip from GitHub and writes /userdata.
// Its own conversion is covered by tests/feedback-sounds.test.mts.
vi.mock('../src/helpers/feedback-sounds.mjs', () => ({
    ensureFeedbackSoundMp3: async (key: string) => ({
        filename: `feedback_${key}.mp3`,
        durationMs: 4000,
    }),
    // The device prewarms the clips at init when it routes audio to Flows; the
    // real one fetches from GitHub, which a unit test has no business doing.
    prewarmFeedbackSounds: async () => undefined,
}));

import { createHarness, Harness } from './mocks/device-harness.mjs';
import { __resetProviderRegistry, createdProviders } from './mocks/mock-voice-provider.mjs';

// Drive a full wake -> mic-open turn (the synchronous part of the 'starting' flow).
function startTurn(h: Harness) {
    h.esp.emit('starting');
}

describe('VoiceAssistantDevice (harness)', () => {
    beforeEach(() => {
        __resetProviderRegistry();
    });

    describe('H2 — concurrent text Flow requests are serialized', () => {
        it('two concurrent askAgentOutputToText calls each get their own answer', async () => {
            const h = await createHarness();
            // Answer every text request asynchronously with an answer derived
            // from the question. Unserialized, both once('text.done') listeners
            // would consume the FIRST emit and both callers would get answer:one.
            h.provider.onTextRequest = (q) => {
                setTimeout(() => h.provider.emit('text.done', { text: `answer:${q}` }), 10);
            };

            const [a, b] = await Promise.all([
                h.device.askAgentOutputToText('one'),
                h.device.askAgentOutputToText('two'),
            ]);

            expect(a).toBe('answer:one');
            expect(b).toBe('answer:two');
        });

        it('a failing request does not wedge the queue for the next one', async () => {
            const h = await createHarness();
            // First request: the provider throws on send. Second: answered normally.
            let call = 0;
            h.provider.sendTextForTextResponse = async (q: string) => {
                if (++call === 1) throw new Error('send failed');
                setTimeout(() => h.provider.emit('text.done', { text: `answer:${q}` }), 10);
            };

            await expect(h.device.askAgentOutputToText('one')).rejects.toThrow('send failed');
            await expect(h.device.askAgentOutputToText('two')).resolves.toBe('answer:two');
        });
    });

    describe('C1 — wake-death recovery', () => {
        it('resets turn state when the ESP connection drops mid-turn', async () => {
            const h = await createHarness();
            startTurn(h);
            expect((h.device as any).turn.isListening).toBe(true);

            // Simulate the ESP link dropping while the mic is open.
            h.esp.emit('Unhealthy');

            expect((h.device as any).turn.isListening).toBe(false);
            // The device told itself/the tile the turn is over.
            expect((h.device as any).audioOutput.isPlaying).toBe(false);
        });

        it('resets turn state when the agent websocket closes mid-turn', async () => {
            const h = await createHarness();
            startTurn(h);
            expect((h.device as any).turn.isListening).toBe(true);

            h.provider.emit('close');

            expect((h.device as any).turn.isListening).toBe(false);
        });

        it('accepts a new wake after a mid-turn drop (no permanent wake-death)', async () => {
            const h = await createHarness();
            startTurn(h);
            const runStartsBefore = h.esp.countOf('run_start');

            h.esp.emit('Unhealthy');       // drop
            startTurn(h);                   // user says the wake word again

            // The second wake was NOT swallowed by the duplicate-wake guard.
            expect(h.esp.countOf('run_start')).toBe(runStartsBefore + 1);
            expect((h.device as any).turn.isListening).toBe(true);
        });

        it('ignores a duplicate wake while already streaming (guard still works)', async () => {
            const h = await createHarness();
            startTurn(h);
            const runStarts = h.esp.countOf('run_start');
            startTurn(h); // duplicate while streaming
            expect(h.esp.countOf('run_start')).toBe(runStarts);
        });
    });

    describe('no-speech timeout — a turn nobody speaks into', () => {
        // Server VAD only reports the END of speech, so total silence produces
        // no event at all. Without the net the mic stays open forever AND the
        // duplicate-wake guard above then swallows every later wake — the
        // satellite goes deaf until it reconnects.
        it('closes the turn and lets the next wake through', async () => {
            const h = await createHarness();
            vi.useFakeTimers();
            try {
                startTurn(h);
                expect((h.device as any).turn.isListening).toBe(true);

                await vi.advanceTimersByTimeAsync(15_000);

                expect((h.device as any).turn.isListening).toBe(false);
                // Closed like an empty transcript, not like a failure: the user
                // simply said nothing, so no error event reaches the device.
                expect(h.esp.countOf('stt_end')).toBe(1);
                expect(h.esp.countOf('pipeline_error')).toBe(0);

                const runStarts = h.esp.countOf('run_start');
                startTurn(h);
                expect(h.esp.countOf('run_start')).toBeGreaterThan(runStarts);
                expect((h.device as any).turn.isListening).toBe(true);
            } finally {
                vi.useRealTimers();
            }
        });

        it('plays the mic-closed cue so the user knows the mic shut', async () => {
            const h = await createHarness();
            vi.useFakeTimers();
            try {
                startTurn(h);
                await vi.advanceTimersByTimeAsync(15_000);

                const played = h.esp.calls.filter((c: any) => c.method === 'playAudioFromUrl');
                expect(played).toHaveLength(1);
                expect(played[0].args[0]).toContain('mic_closed_chime.flac');
            } finally {
                vi.useRealTimers();
            }
        });

        it('stands down once VAD hears speech, however long the user then talks', async () => {
            const h = await createHarness();
            vi.useFakeTimers();
            try {
                startTurn(h);
                h.provider.emit('speech', 'server');

                await vi.advanceTimersByTimeAsync(60_000);

                // Still listening: ending a long sentence is the silence
                // handler's job, not the net's.
                expect((h.device as any).turn.isListening).toBe(true);
                expect(h.esp.countOf('stt_end')).toBe(0);
            } finally {
                vi.useRealTimers();
            }
        });

        it('does not fire against a turn that already ended', async () => {
            const h = await createHarness();
            vi.useFakeTimers();
            try {
                startTurn(h);
                h.esp.emit('Unhealthy');            // turn aborted mid-listen
                const sttEnds = h.esp.countOf('stt_end');

                await vi.advanceTimersByTimeAsync(15_000);

                expect(h.esp.countOf('stt_end')).toBe(sttEnds);
            } finally {
                vi.useRealTimers();
            }
        });
    });

    // The tile's quick action is `onoff`, but the satellite has no power state:
    // on = open the mic without the wake word, off = cancel the running turn.
    // Off used to be dropped on the floor, which made the control look broken.
    describe('onoff capability — start / cancel a conversation', () => {
        it('on opens the mic without the wake word, carrying the listening chime', async () => {
            const h = await createHarness();

            await (h.device as any).invokeCapabilityListener('onoff', true);

            const reopens = h.esp.calls.filter((c: any) => c.method === 'send_voice_assistant_request');
            expect(reopens).toHaveLength(1);
            expect(reopens[0].args[0]).toContain('listening_chime.flac');
        });

        it('off cancels a turn that is in flight', async () => {
            const h = await createHarness();
            startTurn(h);
            expect((h.device as any).turn.isListening).toBe(true);

            await (h.device as any).invokeCapabilityListener('onoff', false);

            expect((h.device as any).turn.isListening).toBe(false);
            // The device is told to leave its listening state, and the user asked
            // for this — so no error chime, unlike a mid-turn failure.
            expect(h.esp.countOf('pipeline_error')).toBe(1);
            expect(h.esp.countOf('run_end')).toBe(1);
            expect(h.esp.countOf('playAudioFromUrl')).toBe(0);
        });

        it('off on an idle satellite is a silent no-op', async () => {
            const h = await createHarness();

            await (h.device as any).invokeCapabilityListener('onoff', false);

            expect(h.esp.countOf('pipeline_error')).toBe(0);
            expect(h.esp.countOf('run_end')).toBe(0);
        });

        it('accepts a new wake after a cancel (cancel is not wake-death)', async () => {
            const h = await createHarness();
            startTurn(h);
            await (h.device as any).invokeCapabilityListener('onoff', false);

            const runStarts = h.esp.countOf('run_start');
            startTurn(h);

            expect(h.esp.countOf('run_start')).toBe(runStarts + 1);
            expect((h.device as any).turn.isListening).toBe(true);
        });
    });

    describe('M3 — onSettings applies the NEW values', () => {
        it('recomputes audio-skip from newSettings, not the stale getSettings()', async () => {
            const h = await createHarness({ settings: { initial_audio_skip: 300 } });
            // Old value is in effect after init.
            expect((h.device as any).skipInitialBytes).toBe(300 * 16000 * 1 * 2 / 1000);

            // Simulate the SDK's onSettings: newSettings carries the change, but
            // getSettings() still returns the old value until this resolves.
            await (h.device as any).onSettings({
                oldSettings: { initial_audio_skip: 300 },
                newSettings: { initial_audio_skip: 500 },
                changedKeys: ['initial_audio_skip'],
            });

            expect((h.device as any).skipInitialBytes).toBe(500 * 16000 * 1 * 2 / 1000);
        });

        it('treats initial_audio_skip = 0 as a deliberate no-skip', async () => {
            const h = await createHarness({ settings: { initial_audio_skip: 300 } });
            await (h.device as any).onSettings({
                oldSettings: { initial_audio_skip: 300 },
                newSettings: { initial_audio_skip: 0 },
                changedKeys: ['initial_audio_skip'],
            });
            expect((h.device as any).skipInitialBytes).toBe(0);
        });
    });

    describe('mic gain — `mic_gain` device setting', () => {
        // The gain is applied IN PLACE on the mic chunk before resampling, so
        // asserting on the emitted buffer observes exactly what the provider gets.
        function pcm(...samples: number[]): Buffer {
            const b = Buffer.alloc(samples.length * 2);
            samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
            return b;
        }
        function samples(b: Buffer): number[] {
            const out: number[] = [];
            for (let i = 0; i + 1 < b.length; i += 2) out.push(b.readInt16LE(i));
            return out;
        }

        it('defaults to the driver default (1x — chunk untouched)', async () => {
            const h = await createHarness();
            startTurn(h);
            const buf = pcm(1000, -1000);
            h.esp.emit('chunk', buf);
            expect(samples(buf)).toEqual([1000, -1000]);
        });

        it('applies the mic_gain setting with int16 clamping', async () => {
            const h = await createHarness({ settings: { mic_gain: 4 } });
            startTurn(h);
            const buf = pcm(1000, -1000, 20000, -20000);
            h.esp.emit('chunk', buf);
            expect(samples(buf)).toEqual([4000, -4000, 32767, -32768]);
        });

        it('treats mic_gain = 0 as automatic (driver default, 1x here)', async () => {
            const h = await createHarness({ settings: { mic_gain: 0 } });
            startTurn(h);
            const buf = pcm(500);
            h.esp.emit('chunk', buf);
            expect(samples(buf)).toEqual([500]);
        });

        it('a mic_gain change via onSettings applies to the next chunk (no restart)', async () => {
            const h = await createHarness();
            await (h.device as any).onSettings({
                oldSettings: { mic_gain: 0 },
                newSettings: { mic_gain: 2 },
                changedKeys: ['mic_gain'],
            });
            startTurn(h);
            const buf = pcm(300);
            h.esp.emit('chunk', buf);
            expect(samples(buf)).toEqual([600]);
        });

        it('rounds fractional gains so writeInt16LE never throws', async () => {
            const h = await createHarness({ settings: { mic_gain: 1.5 } });
            startTurn(h);
            const buf = pcm(333);
            h.esp.emit('chunk', buf);
            expect(samples(buf)).toEqual([500]); // 333 * 1.5 = 499.5 -> rounds to 500
        });
    });

    describe('wake-word selection', () => {
        const nabu = { id: 'okay_nabu', wakeWord: 'Okay Nabu', trainedLanguages: ['en'] };
        const homey = { id: 'hey_homey', wakeWord: 'Hey Homey', trainedLanguages: ['en'] };

        it('activates a wake word by name (case/space-insensitive) via onSettings', async () => {
            const h = await createHarness();
            h.esp.availableWakeWords = [nabu, homey];

            const msg = await (h.device as any).onSettings({
                oldSettings: { wake_word: '' },
                newSettings: { wake_word: 'hey homey' },
                changedKeys: ['wake_word'],
            });

            expect(msg).toContain('Hey Homey');
            const set = h.esp.calls.find(c => c.method === 'setActiveWakeWords');
            expect(set?.args[0]).toEqual(['hey_homey']);
        });

        it('rejects an unknown wake word with the available list in the error', async () => {
            const h = await createHarness();
            h.esp.availableWakeWords = [nabu];

            await expect((h.device as any).onSettings({
                oldSettings: { wake_word: '' },
                newSettings: { wake_word: 'alexa' },
                changedKeys: ['wake_word'],
            })).rejects.toThrow(/Okay Nabu/);
            expect(h.esp.countOf('setActiveWakeWords')).toBe(0);
        });

        it('updates the available_wake_words label when the device reports its config', async () => {
            const h = await createHarness();
            h.esp.emit('wake_words', [nabu, homey], ['okay_nabu'], 1);
            await h.settle(0);
            const settings = (h.device as any).getSettings();
            expect(settings.available_wake_words).toBe('okay_nabu [ACTIVE], hey_homey');
        });
    });

    describe('H-l — announce segments play in order', () => {
        function chunk(marker: number): Buffer {
            // First byte is the marker the fake buildStream keys its delay/URL on.
            return Buffer.from([marker, 0, 0, 0]);
        }

        it('plays the first-emitted segment first even when its encode is slower', async () => {
            // Segment 1 takes 30 ms to "build", segment 2 is instant. Without
            // serialization, segment 2 would win the race and play first.
            const h = await createHarness({ buildStreamDelayByFirstByte: { 1: 30, 2: 0 } });
            const seg = (h.device as any).audioOutput.segmenter;

            seg.emit('chunk', chunk(1));
            seg.emit('chunk', chunk(2));

            await h.settle(80);

            const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
            // First segment plays; second is queued behind it (announce queue).
            expect(plays).toHaveLength(1);
            expect(plays[0].args[0]).toBe('http://x/1.flac');
            expect((h.device as any).audioOutput.queue).toHaveLength(1);
        });

        it('plays the queued next segment on announce_finished, in order', async () => {
            const h = await createHarness({ buildStreamDelayByFirstByte: { 1: 30, 2: 0 } });
            const seg = (h.device as any).audioOutput.segmenter;

            seg.emit('chunk', chunk(1));
            seg.emit('chunk', chunk(2));
            await h.settle(80);

            // First segment finished playing on the device -> play the queued one.
            h.esp.emit('announce_finished');
            await h.settle(10);

            const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
            expect(plays.map(p => p.args[0])).toEqual(['http://x/1.flac', 'http://x/2.flac']);
        });

        it('M9 — extends the announce file TTL by the segment playback length', async () => {
            const h = await createHarness();
            const timeoutSpy = vi.spyOn(h.homey, 'setTimeout');
            const seg = (h.device as any).audioOutput.segmenter;

            // 4800 bytes of PCM16 mono 24 kHz = 100 ms of audio. The deletion
            // timer must be base TTL (30 000 ms) + 100 ms, not the bare TTL.
            seg.emit('chunk', Buffer.alloc(4800));
            await h.settle(10);

            const ttlCalls = timeoutSpy.mock.calls.filter(c => (c[1] as number) >= 30_000);
            expect(ttlCalls).toHaveLength(1);
            expect(ttlCalls[0][1]).toBe(30_100);
            timeoutSpy.mockRestore();
        });
    });

    describe('conversation flow — announce reopen and in-band reply', () => {
        /**
         * Drive one full announce-path turn whose reply ends in a question:
         * wake -> silence -> user transcript -> reply audio segment -> response.done
         * -> announce_finished. Leaves the device in a PE start_conversation session
         * (mic reopened, next turn replies in-band).
         */
        async function runAnnounceTurnEndingInQuestion(h: Harness) {
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', 'hvordan er været?');
            h.provider.emit('transcript.delta', 'Det er fint. Vil du høre mer?');
            const seg = (h.device as any).audioOutput.segmenter;
            seg.emit('chunk', Buffer.from([3, 0, 0, 0]));
            await h.settle(10);
            h.provider.emit('response.done'); // "?" -> continue the conversation
            await h.settle(10);
            h.esp.emit('announce_finished');  // queue empty -> end of playback
            await h.settle(10);               // reopen fires on a 1 ms timeout
        }

        it('a reply ending in "?" ends the announce turn and reopens the mic', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);

            // The reply segment played on the announce path (intent_end -> tts_start -> play).
            expect(h.esp.countOf('playAudioFromUrl')).toBe(1);
            expect(h.esp.countOf('tts_end')).toBe(1);
            expect(h.esp.countOf('run_end')).toBe(1);
            // The question reopened the mic (start_conversation session begins).
            expect(h.esp.countOf('send_voice_assistant_request')).toBe(1);
            expect((h.device as any).turn.peConversationActive).toBe(true);
        });

        it('the mic reopen carries the listening chime URL (fast firmware announce-finish)', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);

            // A real clip makes the firmware end the reopen announce at end of
            // playback instead of its 2 s empty-media fallback timeout.
            const reopen = h.esp.calls.find(c => c.method === 'send_voice_assistant_request');
            expect(reopen?.args[0]).toBe('http://x/listening_chime.flac');
        });

        it('a follow-up turn delivers its reply in-band on TTS_END and closes the session', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);
            const playsBefore = h.esp.countOf('playAudioFromUrl');

            // Follow-up turn (the reopen the PE answered with a new 'starting').
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', 'ja takk');
            h.provider.emit('transcript.delta', 'Her er mer info.'); // no "?" -> close
            const seg = (h.device as any).audioOutput.segmenter;
            seg.emit('chunk', Buffer.alloc(4800, 7));
            await h.settle(5);
            // In-band: the segment is accumulated, NOT played as an announce.
            expect(h.esp.countOf('playAudioFromUrl')).toBe(playsBefore);

            h.provider.emit('response.done'); // flush -> segmenter 'done' -> in-band delivery
            await h.settle(20);

            // INTENT_END tells the PE not to reopen (reply is not a question).
            const intentEnds = h.esp.calls.filter(c => c.method === 'intent_end');
            expect(intentEnds[intentEnds.length - 1].args[1]).toBe(false);
            // TTS_START carries the reply text (firmware discards a text-less one).
            const ttsStarts = h.esp.calls.filter(c => c.method === 'tts_start');
            expect(ttsStarts[ttsStarts.length - 1].args[0]).toBe('Her er mer info.');
            // TTS_END carries the reply file URL (the in-band delivery mechanism).
            const ttsEnds = h.esp.calls.filter(c => c.method === 'tts_end');
            expect(ttsEnds[ttsEnds.length - 1].args[0]).toMatch(/^http:\/\/x\//);
            expect(h.esp.countOf('run_end')).toBe(2);
            // Final reply -> the PE goes idle after playback; session over. NO chime
            // appended: nothing reopens, so a cue would be misleading.
            const finalFile = h.buildStreamCalls[h.buildStreamCalls.length - 1];
            expect(finalFile.length).toBe(4800);
            expect((h.device as any).turn.peConversationActive).toBe(false);
        });

        it('a follow-up reply ending in "?" keeps the session open', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);

            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', 'ja');
            h.provider.emit('transcript.delta', 'Neste spørsmål: hva er 2+2?');
            const seg = (h.device as any).audioOutput.segmenter;
            seg.emit('chunk', Buffer.alloc(4800, 9));
            await h.settle(5);
            h.provider.emit('response.done');
            await h.settle(20);

            const intentEnds = h.esp.calls.filter(c => c.method === 'intent_end');
            expect(intentEnds[intentEnds.length - 1].args[1]).toBe(true); // keep open
            expect((h.device as any).turn.peConversationActive).toBe(true);

            // Keep-open replies carry the listening chime in the file tail: the PE
            // reopens the mic itself at end of playback (no announce of ours), so
            // this is how reopens after the first one get the "speak now" cue.
            const keepOpenFile = h.buildStreamCalls[h.buildStreamCalls.length - 1];
            expect(keepOpenFile.length).toBeGreaterThan(4800);
            // The tail is the chime, not silence: some sample near the end is loud.
            let tailPeak = 0;
            for (let i = keepOpenFile.length - 4800; i < keepOpenFile.length; i += 2) {
                tailPeak = Math.max(tailPeak, Math.abs(keepOpenFile.readInt16LE(i)));
            }
            expect(tailPeak).toBeGreaterThan(3000);
        });

        it('an empty transcript right after a follow-up mic-open retries the mic (spurious VAD trip)', async () => {
            const h = await createHarness();
            await runAnnounceTurnEndingInQuestion(h);
            const reopensBefore = h.esp.countOf('send_voice_assistant_request');

            // Follow-up turn hears "nothing" almost immediately (TTS echo tripped VAD).
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', '');
            await h.settle(10);

            // The turn was retried (mic reopened), not treated as the user leaving.
            expect(h.esp.countOf('send_voice_assistant_request')).toBe(reopensBefore + 1);
            expect((h.device as any).turn.peConversationActive).toBe(true);
            expect((h.device as any).turn.emptyTurnRetries).toBe(1);
        });

        it('an empty transcript on a plain wake turn ends the run without a retry', async () => {
            const h = await createHarness();
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', '');
            await h.settle(10);

            expect(h.esp.countOf('send_voice_assistant_request')).toBe(0);
            // Two run_ends: the turn's own, then the mic-closed chime cue —
            // playUrl wraps the chime announce in its own run_start/run_end pair.
            expect(h.esp.countOf('run_end')).toBe(2);
            const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
            expect(plays[plays.length - 1].args[0]).toBe('http://x/mic_closed_chime.flac');
            expect((h.device as any).turn.peConversationActive).toBe(false);
        });
    });

    /**
     * A turn that produces no reply audio at all. Reached when the pipeline's
     * LLM stage is set to "None" (the transcript is handed to Flows instead of
     * a model), when a model answers with nothing, or when a TTS backend
     * returns no audio. On the announce path nothing is ever queued, so no
     * announce_finished comes back and the run must be closed from here.
     */
    describe('a reply with no audio', () => {
        it('hands the transcript to Flows and closes the run itself', async () => {
            const h = await createHarness();
            const triggered: Array<{ cardId: string; tokens: any }> = [];
            h.homey.flow.getDeviceTriggerCard = (cardId: string) => ({
                trigger: async (_device: any, tokens: any) => { triggered.push({ cardId, tokens }); },
                registerRunListener: () => { },
            });

            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', 'slå på lyset');
            await h.settle(5);
            h.provider.emit('response.done'); // no audio.delta was ever emitted
            await h.settle(10);

            // What the user said reached Flow — the whole point of the mode.
            expect(triggered.filter(t => t.cardId === 'assistant-heard')).toEqual([
                { cardId: 'assistant-heard', tokens: { text: 'slå på lyset' } },
            ]);
            // Nothing was played as a reply, and the PE was walked back to idle:
            // the INTENT_END the first reply segment would have sent, then
            // TTS_END/RUN_END. The second run_end is the mic-closed cue's own
            // announce (playUrl wraps it in a run_start/run_end pair).
            expect(h.esp.countOf('intent_end')).toBe(1);
            expect(h.esp.countOf('run_end')).toBe(2);
            const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
            expect(plays).toHaveLength(1);
            expect(plays[0].args[0]).toBe('http://x/mic_closed_chime.flac');
            expect((h.device as any).turn.state).toBe('idle');
        });

        it('does not close a run that some other path already ended', async () => {
            const h = await createHarness();
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', ''); // empty turn ends the run itself
            await h.settle(10);
            const runEndsBefore = h.esp.countOf('run_end');

            // A stray flush after the run is over must not send a second ending.
            (h.device as any).audioOutput.segmenter.emit('done');
            await h.settle(10);

            expect(h.esp.countOf('run_end')).toBe(runEndsBefore);
        });
    });

    describe('button-pressed trigger (ThirdReality top button)', () => {
        it('fires the button-pressed device trigger with the event type as token', async () => {
            const h = await createHarness();
            const triggered: Array<{ cardId: string; device: any; tokens: any }> = [];
            h.homey.flow.getDeviceTriggerCard = (cardId: string) => ({
                trigger: async (device: any, tokens: any) => { triggered.push({ cardId, device, tokens }); },
                registerRunListener: () => { },
            });

            // The ESP client saw an EventResponse from the device's Event entity.
            h.esp.emit('entity_event', 'button_press', 'single_press');
            await h.settle(0);

            expect(triggered).toHaveLength(1);
            expect(triggered[0].cardId).toBe('button-pressed');
            expect(triggered[0].device).toBe(h.device);
            expect(triggered[0].tokens).toEqual({ event: 'single_press' });
        });

        it('fires with an empty token when the firmware sends no event type', async () => {
            const h = await createHarness();
            const triggered: any[] = [];
            h.homey.flow.getDeviceTriggerCard = () => ({
                trigger: async (_d: any, tokens: any) => { triggered.push(tokens); },
                registerRunListener: () => { },
            });

            h.esp.emit('entity_event', 'button_press', '');
            await h.settle(0);

            expect(triggered).toEqual([{ event: '' }]);
        });
    });

    describe('M4 — runtime voice_provider switch', () => {
        it('rebuilds the provider when voice_provider changes', async () => {
            const h = await createHarness();
            const first = h.provider;
            expect(createdProviders.length).toBe(1);

            // The settings pub/sub delivers a full snapshot; flip the provider.
            await (h.device as any).handleSettingsChange({
                openai_api_key: 'test-key',
                gemini_api_key: 'g-key',
                selected_voice: 'alloy',
                selected_language_code: 'en',
                selected_language_name: 'English',
                ai_instructions: '',
                voice_provider: 'gemini-realtime',
            });

            expect(createdProviders.length).toBe(2);
            const second = createdProviders[1];
            expect(second).not.toBe(first);
            expect(second.providerId).toBe('gemini-realtime');
            expect(second.started).toBe(true);     // new provider connected
            expect(first.destroyed).toBe(true);     // old provider torn down
            expect((h.device as any).currentProviderId).toBe('gemini-realtime');
        });

        it('does not rebuild when voice_provider is unchanged', async () => {
            const h = await createHarness();
            await (h.device as any).handleSettingsChange({
                openai_api_key: 'test-key',
                selected_voice: 'alloy',
                selected_language_code: 'en',
                selected_language_name: 'English',
                ai_instructions: '',
                voice_provider: 'openai-realtime',
            });
            expect(createdProviders.length).toBe(1);
        });
    });

    describe('teardown — a deleted device must not be reachable from its transports', () => {
        // Portal crash report 2026-08-15:
        //   TypeError: Cannot read properties of null (reading 'abort')
        //     at abortCurrentTurn -> provider.on('close') -> WebSocket.onclose
        // onDeleted() nulls audioOutput/esp but used to leave the provider's
        // listeners attached, and close() only ASKS the socket to shut down — its
        // 'close' callback fires a tick later, on a device that no longer has the
        // collaborators the handler reaches into.
        it('survives a late provider close after onDeleted', async () => {
            const h = await createHarness();
            startTurn(h);                       // a turn is in flight when the user deletes
            const provider = h.provider;

            await (h.device as any).onDeleted();

            // The websocket finally closes, one tick after close()/destroy().
            expect(() => provider.emit('close')).not.toThrow();
        });

        it('detaches every provider listener on delete, not just close', async () => {
            const h = await createHarness();
            const provider = h.provider;
            // onInit wired these; if any survives teardown it can still reach a
            // nulled audioOutput/esp.
            expect(provider.listenerCount('close')).toBeGreaterThan(0);

            await (h.device as any).onDeleted();

            for (const event of ['close', 'error', 'Unhealthy', 'Healthy', 'audio.delta', 'response.done']) {
                expect(provider.listenerCount(event)).toBe(0);
            }
            // ('error' is not re-emitted here: EventEmitter throws the payload
            // itself once nothing is listening, which is Node's contract, not our
            // bug — the listener count above is what proves it is detached.)
            expect(() => provider.emit('Unhealthy')).not.toThrow();
        });

        it('abortCurrentTurn is inert once the device is torn down', async () => {
            const h = await createHarness();
            startTurn(h);
            await (h.device as any).onDeleted();

            // Belt-and-braces: any path that slips past the detach must no-op
            // rather than throw on the nulled audioOutput.
            expect(() => (h.device as any).abortCurrentTurn('late event', true)).not.toThrow();
        });
    });

    describe('settings save clears stale conversation context', () => {
        // The snapshot every save delivers when nothing provider-affecting changed
        // (matches the harness defaults, so needRestart stays false).
        const unchangedSnapshot = {
            openai_api_key: 'test-key',
            selected_voice: 'alloy',
            selected_language_code: 'en',
            selected_language_name: 'English',
            ai_instructions: '',
            voice_provider: 'openai-realtime',
        };

        // The very first save after init reconciles timer support against the
        // mock ESP and restarts; prime with one call so the assertions below
        // see a steady-state save.
        async function primedHarness() {
            const h = await createHarness();
            await (h.device as any).handleSettingsChange(unchangedSnapshot);
            h.provider.calls.length = 0;
            return h;
        }

        it('resets the conversation when a save changes nothing that restarts the provider', async () => {
            // e.g. flipping allow_unlock_via_voice: read at tool-call time, no
            // restart — but a cached UNLOCK_DISABLED tool result must not survive.
            const h = await primedHarness();
            await (h.device as any).handleSettingsChange(unchangedSnapshot);
            expect(h.provider.calls).toContain('resetConversation');
            expect(h.provider.calls).not.toContain('restart');
        });

        it('does not double-clear when the save already restarts the provider', async () => {
            const h = await primedHarness();
            await (h.device as any).handleSettingsChange({ ...unchangedSnapshot, selected_voice: 'marin' });
            expect(h.provider.calls).toContain('restart');
            expect(h.provider.calls).not.toContain('resetConversation');
        });

        it('does not yank context out from under a live turn', async () => {
            const h = await primedHarness();
            startTurn(h); // mic streaming — turn state is not idle
            await (h.device as any).handleSettingsChange(unchangedSnapshot);
            expect(h.provider.calls).not.toContain('resetConversation');
            expect(h.provider.calls).not.toContain('restart');
        });
    });

    /**
     * reply_audio_output = 'flow_url': the device plays nothing itself and hands
     * the reply's URL to Flows, so a speaker with no ESPHome involvement (Sonos)
     * can play it. Requested by the ReSpeaker tester, whose board has no speaker.
     */
    describe('reply audio sent to Flows as a URL', () => {
        const flowUrl = () => createHarness({ settings: { reply_audio_output: 'flow_url' } });

        /**
         * The trigger firings that carry a REPLY. A turn on this path also fires
         * the card once at wake time with the "speak now" cue; the is_sound_effect
         * tag is exactly how a Flow tells those apart, so filter on it here too.
         */
        const replyCards = (h: Harness) => h.triggers.filter(
            t => t.cardId === 'reply-audio-ready' && !t.tokens.is_sound_effect);

        /** One plain wake turn whose reply would normally take the announce path. */
        async function runWakeTurn(h: Harness, reply = 'Det er 21 grader.') {
            h.esp.emit('starting');
            h.provider.emit('silence', 'server');
            h.provider.emit('transcript.done', 'hvordan er været?');
            h.provider.emit('transcript.delta', reply);
            const seg = (h.device as any).audioOutput.segmenter;
            seg.emit('chunk', Buffer.alloc(4800, 7));
            await h.settle(5);
            h.provider.emit('response.done');
            await h.settle(20);
        }

        describe('pre-recorded feedback sounds', () => {
            /** Wake a device whose provider has no connection — the error-sound path. */
            async function wakeWithoutAgent(h: Harness) {
                h.provider.close();
                h.esp.emit('starting');
                await h.settle(5);
            }

            it('hands the sound to Flows instead of playing it locally', async () => {
                const h = await flowUrl();
                await wakeWithoutAgent(h);

                const fired = h.triggers.filter(t => t.cardId === 'reply-audio-ready');
                expect(fired).toHaveLength(1);
                // The MP3 we converted and serve ourselves, not the GitHub FLAC:
                // this URL ends up on a third-party speaker.
                expect(fired[0].tokens.url).toBe('http://x/feedback_agent_not_connected.mp3');
                expect(fired[0].tokens.text).toBe('The voice service is not reachable');
                expect(fired[0].tokens.duration).toBe(4);
                // How a Flow tells a canned clip from a real answer.
                expect(fired[0].tokens.is_sound_effect).toBe(true);
                // Nothing may play on a device that has no speaker to play it on.
                expect(h.esp.countOf('playAudioFromUrl')).toBe(0);
            });

            it('picks the sound that matches the failure', async () => {
                const h = await flowUrl();
                h.provider.hasApiKey = () => false;
                await wakeWithoutAgent(h);

                const fired = h.triggers.filter(t => t.cardId === 'reply-audio-ready');
                expect(fired[0].tokens.url).toBe('http://x/feedback_api_key_missing.mp3');
                expect(fired[0].tokens.text).toBe('No API key is configured');
            });

            it('sends the wake cue when a turn starts', async () => {
                // Without it the user gets no sign the wake word landed until the
                // whole answer has been generated — there is no speaker to ding.
                const h = await flowUrl();
                h.esp.emit('starting');
                await h.settle(5);

                const fired = h.triggers.filter(t => t.cardId === 'reply-audio-ready');
                expect(fired).toHaveLength(1);
                expect(fired[0].tokens.url).toBe('http://x/feedback_wake_word_triggered.mp3');
                expect(fired[0].tokens.text).toBe('Wake word detected');
                expect(fired[0].tokens.is_sound_effect).toBe(true);
                // The cue must not hold up the mic.
                expect((h.device as any).turn.isListening).toBe(true);
            });

            it('does not send a wake cue on a device that plays its own audio', async () => {
                // The firmware already dings on its own speaker.
                const h = await createHarness();
                h.esp.emit('starting');
                await h.settle(5);

                expect(h.triggers.filter(t => t.cardId === 'reply-audio-ready')).toHaveLength(0);
                expect(h.esp.countOf('playAudioFromUrl')).toBe(0);
            });

            it('plays the FLAC original on the speaker when replies are not routed to a Flow', async () => {
                // ESPHome compiles in only the decoders its `format:` asks for and
                // these firmwares are built for FLAC — an MP3 URL would not play.
                const h = await createHarness();
                await wakeWithoutAgent(h);

                const plays = h.esp.calls.filter(c => c.method === 'playAudioFromUrl');
                expect(plays).toHaveLength(1);
                expect(plays[0].args[0]).toMatch(/\/agent_not_connected\.flac$/);
                expect(h.triggers.filter(t => t.cardId === 'reply-audio-ready')).toHaveLength(0);
            });
        });

        it('fires reply-audio-ready with the URL, text and duration', async () => {
            const h = await flowUrl();
            await runWakeTurn(h);

            const fired = replyCards(h);
            expect(fired).toHaveLength(1);
            expect(fired[0].tokens.url).toMatch(/^http:\/\/x\//);
            // MP3, not our native FLAC: this URL goes to third-party speakers.
            expect(fired[0].tokens.url).toMatch(/\.mp3$/);
            expect(fired[0].tokens.text).toBe('Det er 21 grader.');
            // 4800 bytes of 24 kHz mono PCM16 = 100 ms, rounded to whole seconds.
            expect(fired[0].tokens.duration).toBe(0);
            // The real answer, not one of the canned clips.
            expect(fired[0].tokens.is_sound_effect).toBe(false);
        });

        it('never hands the device a URL to play', async () => {
            const h = await flowUrl();
            await runWakeTurn(h);

            // Nothing may play locally — not as an announce, and not on TTS_END.
            expect(h.esp.countOf('playAudioFromUrl')).toBe(0);
            const ttsEnds = h.esp.calls.filter(c => c.method === 'tts_end');
            expect(ttsEnds[ttsEnds.length - 1].args[0]).toBeUndefined();
        });

        it('still closes the run so the device leaves its replying phase', async () => {
            const h = await flowUrl();
            await runWakeTurn(h);

            // The announce path would wait for an announce_finished ack that can
            // never arrive with nothing playing; in-band needs no ack.
            expect(h.esp.countOf('run_end')).toBe(1);
            expect((h.device as any).turn.state).toBe('idle');
        });

        it('does not reopen the mic even when the reply is a question', async () => {
            const h = await flowUrl();
            await runWakeTurn(h, 'Vil du høre mer?');

            // Reopening would open the mic while the other speaker is still
            // talking — the assistant would hear itself.
            expect(h.esp.countOf('send_voice_assistant_request')).toBe(0);
            const intentEnds = h.esp.calls.filter(c => c.method === 'intent_end');
            expect(intentEnds[intentEnds.length - 1].args[1]).toBe(false);
            expect((h.device as any).turn.peConversationActive).toBe(false);
        });

        it('encodes at 48 kHz and appends no listening chime', async () => {
            const h = await flowUrl();
            await runWakeTurn(h, 'Vil du høre mer?');

            // 4800 bytes in at 24 kHz -> 9600 out at 48 kHz. A chime would add
            // more on top, and it is precisely what must NOT be there: nothing
            // is reopening, so a "speak now" beep on the Sonos would mislead.
            const sent = h.buildStreamCalls[h.buildStreamCalls.length - 1];
            expect(sent.length).toBe(9600);
        });

        it('routes a Flow "ask" through the same path instead of hanging on announce', async () => {
            const h = await flowUrl();
            await h.device.askAgentOutputToSpeaker('les opp handlelisten');
            h.provider.emit('transcript.delta', 'Melk og brød.');
            const seg = (h.device as any).audioOutput.segmenter;
            seg.emit('chunk', Buffer.alloc(4800, 7));
            await h.settle(5);
            h.provider.emit('response.done');
            await h.settle(20);

            // askAgentOutputToSpeaker calls cancelInband(), which selects the
            // announce path — the one that waits for an ack that never comes.
            expect(h.triggers.filter(t => t.cardId === 'reply-audio-ready')).toHaveLength(1);
            expect(h.esp.countOf('playAudioFromUrl')).toBe(0);
        });

        it('plays on the device when the setting is left at its default', async () => {
            const h = await createHarness();
            await runWakeTurn(h);

            expect(h.triggers.filter(t => t.cardId === 'reply-audio-ready')).toHaveLength(0);
            expect(h.esp.countOf('playAudioFromUrl')).toBe(1);
        });

        it('picks up a settings change on the next turn', async () => {
            const h = await createHarness();
            await (h.device as any).onSettings({
                oldSettings: { reply_audio_output: 'device' },
                newSettings: { reply_audio_output: 'flow_url' },
                changedKeys: ['reply_audio_output'],
            });
            await runWakeTurn(h);

            expect(replyCards(h)).toHaveLength(1);
            expect(h.esp.countOf('playAudioFromUrl')).toBe(0);
        });
    });
});
