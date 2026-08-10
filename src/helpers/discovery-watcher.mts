import { createLogger } from './logger.mjs';
import { seenDevices, SeenDevicesRegistry } from './seen-devices.mjs';
import { probeEspDevice } from '../voice_assistant/esp-probe.mjs';

/**
 * Always-on mDNS observer behind the Debug page's "Last seen devices" list.
 *
 * Homey runs the `esphome` discovery strategy continuously (it is what keeps
 * paired satellites' IPs up to date), but nothing looked at its results outside
 * a pair session. This watcher polls the strategy from the app, records every
 * result in the seen-devices registry, and probes devices it has never probed
 * so the list can mark which ones are usable voice satellites.
 *
 * Polling rather than the strategy's `result` event: the event is not part of
 * the typed SDK surface, the result set is small, and a poll also refreshes
 * `lastSeen` for devices that have stopped announcing.
 */

const DEFAULT_POLL_MS = 60_000;
/** How many never-probed devices are probed per round (one at a time). */
const PROBE_BUDGET_PER_ROUND = 3;
const PROBE_TIMEOUT_MS = 5_000;

export interface DiscoveryWatcherOptions {
    strategyId?: string;
    pollMs?: number;
    /** Test seam. */
    probe?: typeof probeEspDevice;
    registry?: SeenDevicesRegistry;
}

export class DiscoveryWatcher {
    private homey: any;
    private strategyId: string;
    private pollMs: number;
    private probe: typeof probeEspDevice;
    private registry: SeenDevicesRegistry;
    private timer: any = null;
    private running = false;
    private logger = createLogger('Discovery', true);

    constructor(homey: any, options: DiscoveryWatcherOptions = {}) {
        this.homey = homey;
        this.strategyId = options.strategyId ?? 'esphome';
        this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
        this.probe = options.probe ?? probeEspDevice;
        this.registry = options.registry ?? seenDevices;
    }

    /** Start observing. Safe to call when the platform has no discovery manager. */
    start(): void {
        if (this.timer) return;
        // One immediate round so the list isn't empty right after an app restart,
        // then every pollMs.
        void this.round();
        this.timer = this.homey.setInterval(() => { void this.round(); }, this.pollMs);
        this.timer?.unref?.();
    }

    stop(): void {
        if (this.timer) {
            this.homey.clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Read the strategy once, record everything, then probe what we don't know. */
    async round(): Promise<void> {
        // Overlapping rounds would probe the same device twice (a probe round can
        // outlive the poll interval on a slow network).
        if (this.running) return;
        this.running = true;
        try {
            for (const result of this.getDiscoveryResults()) {
                this.registry.recordDiscovery(result);
            }
            await this.probeUnknown();
        } catch (err) {
            this.logger.error('Discovery round failed', err);
        } finally {
            this.running = false;
        }
    }

    /**
     * Results from the app-level discovery strategy. The emulator (and any
     * platform without a discovery manager) has none — that is not an error,
     * the list simply stays fed by the drivers and paired devices.
     */
    private getDiscoveryResults(): any[] {
        try {
            const strategy = this.homey?.discovery?.getStrategy?.(this.strategyId);
            if (!strategy) return [];
            return Object.values(strategy.getDiscoveryResults() ?? {});
        } catch (err) {
            this.logger.warn(`Discovery strategy '${this.strategyId}' unavailable`, err);
            return [];
        }
    }

    /**
     * Probe devices we have never probed, oldest sighting first and one at a
     * time. Encrypted devices are skipped: without the key the handshake can
     * never succeed, and the list already shows them as key-protected.
     * Paired devices are skipped too — their live connection is the better
     * signal and we must not spend one of the satellite's API slots.
     */
    private async probeUnknown(): Promise<void> {
        const candidates = this.registry.unprobed()
            .filter((d) => !!d.address && !d.encrypted)
            .sort((a, b) => a.lastSeen - b.lastSeen)
            .slice(0, PROBE_BUDGET_PER_ROUND);

        for (const device of candidates) {
            const result = await this.probe(this.homey, {
                host: device.address,
                port: device.port,
                timeoutMs: PROBE_TIMEOUT_MS,
            });
            this.registry.recordProbe(device.id, result, 'background');
            this.logger.info(`Probed ${device.pairName || device.id} (${device.address}): ${result.status}`);
        }
    }
}
