import { networkInterfaces } from 'os';
import { createLogger } from './logger.mjs';
import { AudioData, FileInfo } from './interfaces.mjs';
import { saveAudioData } from './file-helper.mjs';

/**
 * True for addresses in Docker's default bridge range, 172.17.0.0/16, and the
 * neighbouring ranges the daemon hands out to user-defined networks
 * (172.18-172.31). Deliberately NOT all of 172.16.0.0/12: 172.16.x and 172.17.x
 * onwards are equally legal on a home LAN, so this only demotes a candidate —
 * it never discards the last one (see getLanIP).
 */
function isContainerBridgeAddress(address: string): boolean {
    const [a, b] = address.split('.').map(Number);
    return a === 172 && b >= 17 && b <= 31;
}

/**
 * `homey.cloud.getLocalAddress()` answers `"<ipv4>:<port>"` (port 80 on every
 * Homey seen so far). Returns the host, keeping a non-80 port so the URL still
 * points at the right listener, or null if the answer isn't an IPv4 address —
 * a hostname or an IPv6 literal would need different URL handling than the bare
 * `http://<host>/…` we build.
 */
function parseLocalAddress(raw: string | null | undefined): string | null {
    const value = raw?.trim();
    if (!value) {
        return null;
    }
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?$/.exec(value);
    if (!m) {
        return null;
    }
    const [host, port] = [m[1], m[2]];
    if (host.split('.').some(part => Number(part) > 255)) {
        return null;
    }
    return port && port !== '80' ? `${host}:${port}` : host;
}

/** How long Homey's self-reported local address is trusted before a refresh. */
const HOMEY_ADDRESS_TTL_MS = 10 * 60_000;

/** Backoff after Homey couldn't (or wouldn't) tell us its local address. */
const HOMEY_ADDRESS_RETRY_MS = 60_000;

/** Cap on the getLocalAddress() call itself — init() waits on it. */
const HOMEY_ADDRESS_TIMEOUT_MS = 5_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); },
        );
    });
}

export class WebServer {
    private homey: any;
    private ip: string | null;
    private logger = createLogger('Web', true);

    // Address a satellite has actually reached us on (the local end of its API
    // socket). Better than interface sniffing: it is the source address of a
    // connection that reaches the device, so on an ordinary LAN it IS our LAN
    // address. Shared across devices because every satellite sits on the same
    // LAN as Homey, so any one of them answers for all. Re-reported on every
    // (re)connect, which is also how a DHCP lease change corrects itself.
    //
    // NOT trusted when it is container-bridge-shaped: where the app container is
    // NATed, the socket's local end is the container's own 172.17.x address
    // while the satellite still reaches Homey on its LAN address. See getLanIP.
    private reportedIp: string | null = null;

    // Homey's own answer to "what is my address on the LAN", host[:port] —
    // `homey.cloud.getLocalAddress()`. Authoritative, and the only source here
    // that sees past the app container's own interfaces. Refreshed in the
    // background so a DHCP lease change is picked up.
    private homeyLocalHost: string | null = null;
    private homeyLocalHostNextFetchAt = 0;
    private homeyLocalHostFetch: Promise<void> | null = null;

    constructor(homey: any) {
        this.homey = homey;
        this.ip = null;
    }

    async init(): Promise<void> {
        await this.refreshHomeyLocalHost();
        this.ip = this.getLanIP();
    }

    /**
     * Called when a device's API connection comes up, with the local address of
     * that socket. See `reportedIp`.
     */
    reportReachableIp(ip: string | null | undefined): void {
        const trimmed = ip?.trim();
        if (!trimmed || trimmed === this.reportedIp) {
            return;
        }
        if (isContainerBridgeAddress(trimmed)) {
            // Our end of the socket is the app container's bridge address, so the
            // connection to the device is NATed and this address means nothing to
            // anyone but the container. Recorded (it is still the truth about the
            // socket) but ranked below Homey's own local address in getLanIP.
            this.logger.info(`Device connection is NATed (our end is ${trimmed}) — not using it for audio URLs`, 'IP');
        } else {
            this.logger.info(`Device reached us on ${trimmed} — using it for audio URLs`, 'IP');
        }
        this.reportedIp = trimmed;
    }

    /**
     * Ask Homey where it lives on the LAN. Returns host[:port] (the port is kept
     * only when it isn't 80, so ordinary Homeys keep producing bare-host URLs).
     * Never throws: any failure just leaves the previous value in place.
     */
    private async refreshHomeyLocalHost(): Promise<void> {
        if (this.homeyLocalHostFetch) {
            return this.homeyLocalHostFetch;
        }
        this.homeyLocalHostFetch = (async () => {
            try {
                const getLocalAddress = this.homey?.cloud?.getLocalAddress;
                if (typeof getLocalAddress !== 'function') {
                    // No cloud manager — the emulator and the unit tests. They
                    // rely on HE_HOST_IP or interface sniffing instead, and it is
                    // never going to appear later, so stop asking.
                    this.homeyLocalHostNextFetchAt = Infinity;
                    return;
                }
                // Timed out rather than awaited outright: init() blocks on this
                // call, and a manager that never answers must not hold up the
                // whole app boot — the fallbacks below are what that costs us.
                const raw = await withTimeout<string | undefined>(
                    getLocalAddress.call(this.homey.cloud),
                    HOMEY_ADDRESS_TIMEOUT_MS,
                );
                const host = parseLocalAddress(raw);
                if (!host) {
                    this.logger.warn(`Homey reported an unusable local address: ${JSON.stringify(raw)}`);
                    this.homeyLocalHostNextFetchAt = Date.now() + HOMEY_ADDRESS_RETRY_MS;
                    return;
                }
                if (host !== this.homeyLocalHost) {
                    this.logger.info(`Homey reports its local address as ${host}`, 'IP');
                }
                this.homeyLocalHost = host;
                this.homeyLocalHostNextFetchAt = Date.now() + HOMEY_ADDRESS_TTL_MS;
            } catch (err) {
                // Typically "Homey is offline" at boot. Retry soon rather than in
                // ten minutes: until it answers, URLs fall back to sniffing, which
                // is exactly the thing that can advertise the container bridge.
                this.logger.warn('Could not ask Homey for its local address', err);
                this.homeyLocalHostNextFetchAt = Date.now() + HOMEY_ADDRESS_RETRY_MS;
            } finally {
                this.homeyLocalHostFetch = null;
            }
        })();
        return this.homeyLocalHostFetch;
    }

    /** Kick off a refresh (not awaited) once the cached address goes stale. */
    private refreshHomeyLocalHostIfStale(): void {
        if (Date.now() < this.homeyLocalHostNextFetchAt) {
            return;
        }
        void this.refreshHomeyLocalHost();
    }

    async stop(): Promise<void> {

    }

    /**
     * URL for a persistent (non-turn) file in the audio folder — same shape as
     * buildStream URLs, IP re-resolved per call (DHCP lease can change).
     */
    buildStaticUrl(filename: string): string {
        this.ip = this.getLanIP();
        return `http://${this.ip}/app/${this.homey.manifest.id}/userdata/audio/${filename}`;
    }

    async buildStream(audioData: AudioData): Promise<FileInfo> {
        const fileInfo = await saveAudioData(this.homey, audioData);
        // Re-resolve per file: the IP was previously cached once at init, so a
        // DHCP lease change left every later URL pointing at the old address.
        this.ip = this.getLanIP();
        fileInfo.url = `http://${this.ip}/app/${this.homey.manifest.id}/userdata/audio/${fileInfo.filename}`;
        return fileInfo;
    }



    /**
     * The host to advertise in audio URLs — normally a bare LAN IP, but
     * host:port if Homey ever reports a non-80 port. Four sources, best first;
     * see the fields and comments for why each ranks where it does.
     */
    getLanIP(): string {

        // Allow overriding the advertised host IP (e.g. when running under the
        // emulator, where auto-detection may pick the wrong interface so the PE
        // can't reach the reply URL). Unset on a real Homey.
        const override = process.env.HE_HOST_IP?.trim();
        if (override) {
            this.logger.info(`Using IP override from HE_HOST_IP: ${override}`, 'IP');
            return override;
        }

        this.refreshHomeyLocalHostIfStale();

        // A satellite told us which address it reached us on. Nothing derived
        // from the interface list can beat that, so it wins over the sniffing
        // below (which cannot tell Homey's LAN address from the app container's
        // Docker-bridge address — both interfaces are named `eth0`).
        if (this.reportedIp && !isContainerBridgeAddress(this.reportedIp)) {
            return this.reportedIp;
        }

        // Our socket to the device is NATed, or no device is connected yet.
        // Homey's own local address is the one source that sees past the app
        // container's interfaces, so it outranks both the NATed socket address
        // and anything the sniffing below could find.
        if (this.homeyLocalHost) {
            return this.homeyLocalHost;
        }

        this.logger.info('Determining LAN IP address...', 'IP');
        let bestChoice: {
            address: string | null,
            name: string | null
        } = {
            address: null,
            name: null
        };

        const ifaces = networkInterfaces();

        // Container-bridge addresses are the trap this loop exists to avoid: the
        // app runs in a container whose veth is also called `eth0`, so a
        // name-only "wired wins" rule can return 172.17.0.2 — reachable from
        // nowhere on the LAN. Such an address is kept only as a last resort.
        let fallback: { address: string, name: string } | null = null;

        for (const [name, addrs] of Object.entries(ifaces)) {
            if (!addrs) continue;

            const wired = (/^(eth|en|enx)/i.test(name));
            const ip4 = addrs.find(a => a.family === 'IPv4' && !a.internal);

            if (!ip4) continue;

            if (ip4.address.startsWith('169.254.')) {
                // Skip link-local addresses
                continue;
            }

            if (isContainerBridgeAddress(ip4.address)) {
                this.logger.info(`Ignoring container-bridge address ${ip4.address} on ${name}`, 'IP');
                fallback ??= { address: ip4.address, name };
                continue;
            }

            if (wired) {
                this.logger.info(`Using wired interface ${name} with IP ${ip4.address}`, 'IP');
                return ip4.address;
            }

            this.logger.info(`Found IPv4 address on interface ${name} with IP ${ip4.address}`, 'IP');
            bestChoice.address = ip4.address;
            bestChoice.name = name;
        }

        if (bestChoice.address) {
            this.logger.info(`Using best available interface ${bestChoice.name} with IP ${bestChoice.address}`, 'IP');
            return bestChoice.address;
        }

        if (fallback ?? this.reportedIp) {
            // Every candidate looked like a container bridge, and Homey either
            // hasn't answered yet or couldn't. Homey itself could genuinely sit
            // on 172.16/12, and a wrong-but-plausible address beats 127.0.0.1,
            // which is wrong for certain.
            const last = fallback?.address ?? this.reportedIp!;
            this.logger.warn(`Only container-bridge-shaped addresses found; falling back to ${last}${fallback ? ` on ${fallback.name}` : ''}`);
            return last;
        }

        this.logger.warn('Could not determine LAN IP, defaulting to localhost');
        return '127.0.0.1';
    }
}

