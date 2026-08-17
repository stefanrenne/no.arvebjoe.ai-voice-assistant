import { EspProbeResult, EspProbeStatus } from '../voice_assistant/esp-probe.mjs';

/**
 * "Last seen devices" — the Debug settings page's answer to *"why doesn't my
 * satellite show up when I pair?"*.
 *
 * Every ESPHome device Homey's mDNS discovery surfaces is recorded here with
 * the exact fields the pair flow matches on (see
 * VoiceAssistantDriver.resultToDevice and .homeycompose/discovery/esphome.json),
 * plus the outcome of the capability probe. Recording runs all the time — not
 * only inside a pair session — so the list is already populated when the user
 * goes looking.
 *
 * Sources that feed the registry:
 *   - DiscoveryWatcher (app-level, always on): mDNS results + background probes
 *   - VoiceAssistantDriver: probe outcomes from a live pair session
 *   - VoiceAssistantDevice: paired/available state of devices we own
 *
 * Pure data + bookkeeping — no Homey APIs — so it unit-tests without mocks.
 */

/** How many devices are remembered. Oldest un-paired entries are evicted first. */
export const MAX_SEEN_DEVICES = 30;

/** Who ran the probe (shown in the UI so a stale result can be explained). */
export type ProbeSource = 'pairing' | 'background' | 'manual';

export interface SeenDeviceProbe {
    status: EspProbeStatus;
    deviceType: string | null;
    mediaPlayers: number;
    subscribeVoiceAssistant: number;
    voiceAssistantConfiguration: number;
    code: string;
    message: string;
    at: number;
    by: ProbeSource;
}

export interface SeenDevice {
    /** Discovery id — mDNS `txt.mac`; the same id a paired device carries in data.id. */
    id: string;
    /** mDNS instance name, e.g. `home-assistant-voice-09a1b2`. */
    name: string;
    /** `txt.friendly_name` — what the pair list shows when present. */
    friendlyName: string;
    /** The name the pair list WOULD show (friendly_name || name || host). */
    pairName: string;
    host: string;
    address: string;
    port: number;
    /** `txt.mac` (bare lowercase hex, as ESPHome advertises it). */
    mac: string;
    /** `txt.platform` — the field the discovery filter matches on. */
    platform: string;
    /** `txt.version` — the ESPHome version running on the device. */
    version: string;
    /** `txt.project_name` + `txt.project_version`, joined. */
    project: string;
    board: string;
    network: string;
    /** `txt.api_encryption` is set — the device refuses plaintext. */
    encrypted: boolean;
    /** Every TXT record, for the raw view. */
    txt: Record<string, string>;
    firstSeen: number;
    lastSeen: number;
    /** How many discovery rounds have seen it (a flapping device shows a low count). */
    seenCount: number;
    /** A device of this app is paired with this id. */
    paired: boolean;
    pairedName: string;
    /** Paired-device availability (its ESP client + provider are healthy); null when not paired. */
    available: boolean | null;
    /**
     * The two INDEPENDENT links behind `available`, carried separately so the
     * Debug page can say which one is down. `available` is a single AND, and
     * that is exactly what sent a field reporter after the network when the
     * engine's API key was the problem (TODO.md, § Diagnosability).
     * Null when not paired, or when nothing has reported yet.
     */
    deviceConnected: boolean | null;
    engineConnected: boolean | null;
    /** Which engine `engineConnected` refers to (e.g. "OpenAI Realtime"). */
    engineName: string;
    probe: SeenDeviceProbe | null;
}

/** The shape the settings page renders: a SeenDevice plus the computed star. */
export interface SeenDeviceView extends SeenDevice {
    /** The star: we know this device can serve as a voice satellite right now. */
    accessible: boolean;
}

/** Minimal shape of a Homey mDNS-SD discovery result (only what we read). */
export interface DiscoveryResultLike {
    id: string;
    name?: string;
    host?: string;
    address?: string;
    port?: number | string;
    txt?: Record<string, any>;
    lastSeen?: Date | number;
}

function str(value: any): string {
    return value === undefined || value === null ? '' : String(value);
}

function joinProject(txt: Record<string, string>): string {
    const name = txt.project_name ?? '';
    const version = txt.project_version ?? '';
    if (name && version) return `${name} ${version}`;
    return name || version;
}

export class SeenDevicesRegistry {
    private devices = new Map<string, SeenDevice>();

    /** Upsert from an mDNS discovery result. Returns the stored entry. */
    recordDiscovery(result: DiscoveryResultLike, now: number = Date.now()): SeenDevice {
        const id = str(result.id) || str(result.txt?.mac) || str(result.address);
        const txt: Record<string, string> = {};
        for (const [k, v] of Object.entries(result.txt ?? {})) txt[k] = str(v);

        const name = str(result.name);
        const host = str(result.host);
        const friendlyName = txt.friendly_name ?? '';
        const existing = this.devices.get(id);

        const entry: SeenDevice = {
            ...(existing ?? this.blank(id, now)),
            name,
            friendlyName,
            // Mirrors resultToDevice(): this is the label the pair list uses.
            pairName: friendlyName || name || host || `ESPHome ${id.slice(-4)}`,
            host,
            address: str(result.address),
            port: Number(result.port) || 6053,
            mac: txt.mac ?? '',
            platform: txt.platform ?? '',
            version: txt.version ?? '',
            project: joinProject(txt),
            board: txt.board ?? '',
            network: txt.network ?? '',
            encrypted: !!txt.api_encryption,
            txt,
            lastSeen: now,
            seenCount: (existing?.seenCount ?? 0) + 1,
        };

        // An address change invalidates a probe result that was taken against
        // the old IP — drop it so the watcher probes the new address.
        if (existing && existing.address && existing.address !== entry.address) {
            entry.probe = null;
        }

        this.devices.set(id, entry);
        this.evict();
        return entry;
    }

    /** Record the outcome of a capability probe against a known (or new) device. */
    recordProbe(id: string, result: EspProbeResult, by: ProbeSource, now: number = Date.now()): void {
        const entry = this.devices.get(id) ?? this.blank(id, now);
        entry.probe = {
            status: result.status,
            deviceType: result.deviceType,
            mediaPlayers: result.mediaPlayers,
            subscribeVoiceAssistant: result.subscribeVoiceAssistant,
            voiceAssistantConfiguration: result.voiceAssistantConfiguration,
            code: result.code,
            message: result.message,
            at: now,
            by,
        };
        // A probe answer is also a sighting: a device reachable by IP but not by
        // mDNS (the manual-entry case) still belongs in the list.
        entry.lastSeen = now;
        if (!entry.mac && result.mac) entry.mac = result.mac;
        if (!entry.friendlyName && result.friendlyName) {
            entry.friendlyName = result.friendlyName;
            if (!entry.pairName) entry.pairName = result.friendlyName;
        }
        this.devices.set(id, entry);
        this.evict();
    }

    /**
     * Flag a device this app has paired (called by every VoiceAssistantDevice on
     * init and whenever its availability flips), so the list distinguishes "seen
     * on the network" from "already mine".
     */
    markPaired(
        id: string,
        info: {
            name?: string; address?: string; port?: number; mac?: string;
            available?: boolean | null;
            deviceConnected?: boolean | null;
            engineConnected?: boolean | null;
            engineName?: string;
        },
        now: number = Date.now(),
    ): void {
        const entry = this.devices.get(id) ?? this.blank(id, now);
        entry.paired = true;
        if (info.name) {
            entry.pairedName = info.name;
            if (!entry.pairName) entry.pairName = info.name;
        }
        if (info.address) entry.address = info.address;
        if (info.port) entry.port = info.port;
        if (info.mac && !entry.mac) entry.mac = info.mac;
        entry.available = info.available ?? entry.available ?? null;
        entry.deviceConnected = info.deviceConnected ?? entry.deviceConnected ?? null;
        entry.engineConnected = info.engineConnected ?? entry.engineConnected ?? null;
        if (info.engineName) entry.engineName = info.engineName;
        this.devices.set(id, entry);
        this.evict();
    }

    /** A paired device was removed from Homey (or its app instance went away). */
    markUnpaired(id: string): void {
        const entry = this.devices.get(id);
        if (!entry) return;
        entry.paired = false;
        entry.available = null;
        entry.deviceConnected = null;
        entry.engineConnected = null;
    }

    get(id: string): SeenDevice | undefined {
        return this.devices.get(id);
    }

    /** Newest sighting first, with the star computed. */
    list(): SeenDeviceView[] {
        return [...this.devices.values()]
            .sort((a, b) => b.lastSeen - a.lastSeen)
            .map((d) => ({ ...d, accessible: SeenDevicesRegistry.isAccessible(d) }));
    }

    /** Devices that have never been probed (candidates for a background probe). */
    unprobed(): SeenDevice[] {
        return [...this.devices.values()].filter((d) => d.probe === null && !d.paired);
    }

    size(): number {
        return this.devices.size;
    }

    clear(): void {
        this.devices.clear();
    }

    /**
     * The star: either the probe found a usable voice satellite, or it is one of
     * ours and currently connected (a paired device holds the API connection, so
     * its live health is the better signal than an old probe).
     */
    static isAccessible(d: SeenDevice): boolean {
        if (d.paired && d.available === true) return true;
        return d.probe?.status === 'accessible';
    }

    private blank(id: string, now: number): SeenDevice {
        return {
            id,
            name: '',
            friendlyName: '',
            pairName: '',
            host: '',
            address: '',
            port: 6053,
            mac: '',
            platform: '',
            version: '',
            project: '',
            board: '',
            network: '',
            encrypted: false,
            txt: {},
            firstSeen: now,
            lastSeen: now,
            seenCount: 0,
            paired: false,
            pairedName: '',
            available: null,
            deviceConnected: null,
            engineConnected: null,
            engineName: '',
            probe: null,
        };
    }

    /**
     * Keep the newest MAX_SEEN_DEVICES. Paired devices are never evicted — they
     * are the ones the user is most likely debugging — so a network full of
     * ESPHome nodes can't push them out of the list.
     */
    private evict(): void {
        if (this.devices.size <= MAX_SEEN_DEVICES) return;
        const evictable = [...this.devices.values()]
            .filter((d) => !d.paired)
            .sort((a, b) => a.lastSeen - b.lastSeen);
        let over = this.devices.size - MAX_SEEN_DEVICES;
        for (const d of evictable) {
            if (over-- <= 0) break;
            this.devices.delete(d.id);
        }
    }
}

/** App-wide singleton — the settings API, the drivers and the devices all write here. */
export const seenDevices = new SeenDevicesRegistry();
