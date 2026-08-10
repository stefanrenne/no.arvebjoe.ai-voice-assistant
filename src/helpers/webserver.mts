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

export class WebServer {
    private homey: any;
    private ip: string | null;
    private logger = createLogger('Web', true);

    // Address a satellite has actually reached us on (the local end of its API
    // socket). Beats interface sniffing outright: it is routable from the device
    // by construction. Shared across devices because every satellite sits on the
    // same LAN as Homey, so any one of them answers for all. Re-reported on every
    // (re)connect, which is also how a DHCP lease change corrects itself.
    private reportedIp: string | null = null;

    constructor(homey: any) {
        this.homey = homey;
        this.ip = null;
    }

    async init(): Promise<void> {
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
        this.logger.info(`Device reached us on ${trimmed} — using it for audio URLs`, 'IP');
        this.reportedIp = trimmed;
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



    getLanIP(): string {

        // Allow overriding the advertised host IP (e.g. when running under the
        // emulator, where auto-detection may pick the wrong interface so the PE
        // can't reach the FLAC URL). Unset on a real Homey.
        const override = process.env.HE_HOST_IP?.trim();
        if (override) {
            this.logger.info(`Using IP override from HE_HOST_IP: ${override}`, 'IP');
            return override;
        }

        // A satellite told us which address it reached us on. Nothing derived
        // from the interface list can beat that, so it wins over the sniffing
        // below (which cannot tell Homey's LAN address from the app container's
        // Docker-bridge address — both interfaces are named `eth0`).
        if (this.reportedIp) {
            return this.reportedIp;
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

        if (fallback) {
            // Every candidate looked like a container bridge. Homey itself could
            // genuinely sit on 172.16/12, and a wrong-but-plausible address beats
            // 127.0.0.1, which is wrong for certain.
            this.logger.warn(`Only container-bridge-shaped addresses found; falling back to ${fallback.address} on ${fallback.name}`);
            return fallback.address;
        }

        this.logger.warn('Could not determine LAN IP, defaulting to localhost');
        return '127.0.0.1';
    }
}

