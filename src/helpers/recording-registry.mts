import { promises as fs } from 'fs';
import { createLogger } from './logger.mjs';
import { FileInfo } from './interfaces.mjs';

/**
 * "What did I just say?" — the recordings half of the Debug settings page.
 *
 * When `debug_audio_enabled` is on, every turn's raw microphone audio is
 * encoded to FLAC (the `rx_*` files in /userdata/audio) and registered here
 * together with what speech-to-text made of it. The files normally live ~30 s
 * (they are served to the satellite and deleted); a recording instead lives for
 * the retention window the user picked, so it can still be played back
 * afterwards from the Debug page ("Play on device"). That page is the only way
 * in — the assistant has no tool for it, since asking "what did I just say?"
 * out loud only ever got the question itself read back.
 *
 * Playback goes to the satellite that recorded it: each device registers a
 * player callback here on init, so the settings API never has to look devices
 * up through the driver.
 */

/** How many recordings are kept in the list (per app, newest first). */
export const MAX_RECORDINGS = 20;

export interface Recording {
    /** The filename, which is also the id (uuid-based, unique per turn). */
    id: string;
    filename: string;
    filepath: string;
    url: string;
    deviceId: string;
    deviceName: string;
    /** When the turn was recorded (epoch ms). */
    at: number;
    /** Length of the captured audio. */
    durationMs: number;
    /** What STT made of it — '' until the transcript arrives (or if none did). */
    transcript: string;
    /** When the file is deleted (epoch ms). */
    expiresAt: number;
}

type PlayFn = (recordings: Recording[]) => Promise<void>;

export class RecordingRegistry {
    private homey: any = null;
    private items: Recording[] = [];
    private players = new Map<string, PlayFn>();
    private timers = new Map<string, any>();
    private logger = createLogger('Recordings', true);

    /** Called once from the app; without it nothing schedules deletions. */
    init(homey: any): void {
        this.homey = homey;
    }

    /**
     * Register a recording and schedule its file for deletion. `retentionMs`
     * comes from the `debug_audio_retention_min` setting.
     */
    add(entry: {
        file: FileInfo;
        deviceId: string;
        deviceName: string;
        durationMs: number;
        retentionMs: number;
        at?: number;
    }): Recording {
        const at = entry.at ?? Date.now();
        const recording: Recording = {
            id: entry.file.filename,
            filename: entry.file.filename,
            filepath: entry.file.filepath,
            url: entry.file.url,
            deviceId: entry.deviceId,
            deviceName: entry.deviceName,
            at,
            durationMs: Math.max(0, Math.round(entry.durationMs)),
            transcript: '',
            expiresAt: at + Math.max(1000, entry.retentionMs),
        };

        this.items.unshift(recording);
        this.scheduleDeletion(recording);

        // Trim the tail (deleting those files too — the retention timer would
        // fire later on an entry nobody can reach any more). remove() does the
        // splice itself, so the entry must still be in the list when it runs.
        while (this.items.length > MAX_RECORDINGS) {
            void this.remove(this.items[this.items.length - 1].id);
        }

        return recording;
    }

    /** Attach the transcript once speech-to-text has produced it. */
    setTranscript(id: string, transcript: string): void {
        const item = this.items.find((r) => r.id === id);
        if (item) item.transcript = transcript ?? '';
    }

    /** Newest first; `deviceId` narrows the list to one satellite. */
    list(deviceId?: string): Recording[] {
        const now = Date.now();
        return this.items
            .filter((r) => r.expiresAt > now && (!deviceId || r.deviceId === deviceId))
            .map((r) => ({ ...r }));
    }

    get(id: string): Recording | undefined {
        return this.items.find((r) => r.id === id);
    }

    /** Register how to play recordings on a given satellite. Returns an unsubscribe. */
    registerPlayer(deviceId: string, play: PlayFn): () => void {
        this.players.set(deviceId, play);
        return () => {
            if (this.players.get(deviceId) === play) this.players.delete(deviceId);
        };
    }

    /**
     * Play the given recordings on the satellite that recorded them. Resolves
     * when playback is done (the player waits out each clip), so a tool call can
     * await it and the assistant's reply lands after the audio.
     */
    async play(recordings: Recording[]): Promise<{ played: number; message: string }> {
        if (!recordings.length) {
            return { played: 0, message: 'No recordings available' };
        }
        // Group per device so a mixed selection still reaches the right speakers.
        const byDevice = new Map<string, Recording[]>();
        for (const r of recordings) {
            const list = byDevice.get(r.deviceId) ?? [];
            list.push(r);
            byDevice.set(r.deviceId, list);
        }

        let played = 0;
        const missing: string[] = [];
        for (const [deviceId, list] of byDevice) {
            const player = this.players.get(deviceId);
            if (!player) {
                missing.push(list[0]?.deviceName || deviceId);
                continue;
            }
            await player(list);
            played += list.length;
        }

        if (!played) {
            return { played: 0, message: `No connected satellite to play on (${missing.join(', ')})` };
        }
        return {
            played,
            message: missing.length
                ? `Played ${played}; skipped recordings from ${missing.join(', ')} (device not available)`
                : `Played ${played} recording${played === 1 ? '' : 's'}`,
        };
    }

    /** Drop an entry and delete its file. */
    async remove(id: string): Promise<void> {
        const index = this.items.findIndex((r) => r.id === id);
        const item = index >= 0 ? this.items[index] : undefined;
        if (index >= 0) this.items.splice(index, 1);

        const timer = this.timers.get(id);
        if (timer) {
            this.homey?.clearTimeout?.(timer);
            this.timers.delete(id);
        }
        if (!item) return;

        try {
            await fs.unlink(item.filepath);
        } catch (err: any) {
            // ENOENT is normal: the file may already be gone (app restart wipes
            // the audio folder, or another TTL got there first).
            if (err?.code !== 'ENOENT') {
                this.logger.error(`Failed to delete recording ${item.filename}`, err);
            }
        }
    }

    /** Drop every entry (and its file). */
    async clear(): Promise<void> {
        const ids = this.items.map((r) => r.id);
        for (const id of ids) await this.remove(id);
    }

    private scheduleDeletion(recording: Recording): void {
        if (!this.homey?.setTimeout) return;
        const timer = this.homey.setTimeout(
            () => { void this.remove(recording.id); },
            Math.max(1000, recording.expiresAt - Date.now()),
        );
        timer?.unref?.();
        this.timers.set(recording.id, timer);
    }
}

/** App-wide singleton — devices write, the tool and the settings API read. */
export const recordingRegistry = new RecordingRegistry();

/** Retention window (ms) from the `debug_audio_retention_min` setting. */
export function retentionMsFromSetting(value: any, fallbackMinutes = 15): number {
    const minutes = Number(value);
    const safe = Number.isFinite(minutes) && minutes > 0 ? minutes : fallbackMinutes;
    // An hour is plenty for "what did I just say?" and bounds the disk use of
    // ~20 recordings on a Homey.
    return Math.min(60, safe) * 60_000;
}
