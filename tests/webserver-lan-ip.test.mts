import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// os.networkInterfaces() is the whole input to the heuristic, so it is mocked
// per-test. Must be hoisted above the WebServer import.
const { interfacesMock } = vi.hoisted(() => ({ interfacesMock: vi.fn() }));
vi.mock('os', () => ({ networkInterfaces: interfacesMock }));

const { WebServer } = await import('../src/helpers/webserver.mjs');

/** Shorthand for one non-internal IPv4 entry as os.networkInterfaces() reports it. */
function iface(address: string) {
    return [{ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '', cidr: null }];
}

/**
 * `localAddress` is what `homey.cloud.getLocalAddress()` resolves to; omit it
 * for a Homey without a cloud manager (the emulator and most of these tests).
 */
function makeWebServer(localAddress?: string | (() => Promise<string>)) {
    const cloud = localAddress === undefined ? undefined : {
        getLocalAddress: typeof localAddress === 'function'
            ? localAddress
            : async () => localAddress,
    };
    return new WebServer({ manifest: { id: 'no.arvebjoe.ai-voice-assistant' }, cloud } as any);
}

describe('WebServer.getLanIP', () => {
    beforeEach(() => {
        interfacesMock.mockReset();
        delete process.env.HE_HOST_IP;
    });
    afterEach(() => { delete process.env.HE_HOST_IP; });

    it('prefers the address a device reached us on over any interface', () => {
        // The exact trap from the ReSpeaker field report: the container veth is
        // also called eth0, so name-based "wired wins" would pick 172.17.0.2.
        interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
        const ws = makeWebServer();
        ws.reportReachableIp('192.168.1.107');
        expect(ws.getLanIP()).toBe('192.168.1.107');
    });

    it('skips a Docker-bridge address in favour of a real LAN interface', () => {
        // eth0 enumerates first and is "wired", so only the bridge check saves this.
        interfacesMock.mockReturnValue({
            eth0: iface('172.17.0.2'),
            wlan0: iface('192.168.1.107'),
        });
        expect(makeWebServer().getLanIP()).toBe('192.168.1.107');
    });

    it('falls back to a bridge-shaped address when it is the only candidate', () => {
        // Homey could genuinely sit on 172.17/16; a plausible address beats 127.0.0.1.
        interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
        expect(makeWebServer().getLanIP()).toBe('172.17.0.2');
    });

    it('does not treat 172.16.x as a container bridge', () => {
        interfacesMock.mockReturnValue({ eth0: iface('172.16.4.20') });
        expect(makeWebServer().getLanIP()).toBe('172.16.4.20');
    });

    it('still prefers a wired interface over wireless', () => {
        interfacesMock.mockReturnValue({
            wlan0: iface('192.168.1.50'),
            eth0: iface('192.168.1.107'),
        });
        expect(makeWebServer().getLanIP()).toBe('192.168.1.107');
    });

    it('skips link-local addresses', () => {
        interfacesMock.mockReturnValue({
            eth0: iface('169.254.3.4'),
            wlan0: iface('192.168.1.107'),
        });
        expect(makeWebServer().getLanIP()).toBe('192.168.1.107');
    });

    it('lets HE_HOST_IP override even a reported address', () => {
        interfacesMock.mockReturnValue({ eth0: iface('192.168.1.107') });
        process.env.HE_HOST_IP = '10.0.0.5';
        const ws = makeWebServer();
        ws.reportReachableIp('192.168.1.107');
        expect(ws.getLanIP()).toBe('10.0.0.5');
    });

    it('still uses a NATed reported address when nothing better exists at all', () => {
        // No cloud manager, no usable interface: a bridge address is wrong, but
        // 127.0.0.1 is wrong for certain.
        interfacesMock.mockReturnValue({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] });
        const ws = makeWebServer();
        ws.reportReachableIp('172.17.0.2');
        expect(ws.getLanIP()).toBe('172.17.0.2');
    });

    it('defaults to localhost when there is nothing usable', () => {
        interfacesMock.mockReturnValue({ lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] });
        expect(makeWebServer().getLanIP()).toBe('127.0.0.1');
    });

    it('ignores empty or unchanged reports', () => {
        interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
        const ws = makeWebServer();
        ws.reportReachableIp(null);
        ws.reportReachableIp('   ');
        expect(ws.getLanIP()).toBe('172.17.0.2');
    });

    it('adopts a new reported address after a DHCP change', () => {
        interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
        const ws = makeWebServer();
        ws.reportReachableIp('192.168.1.107');
        ws.reportReachableIp('192.168.1.180');
        expect(ws.getLanIP()).toBe('192.168.1.180');
    });

    describe("Homey's own local address", () => {
        it('beats interface sniffing that can only see the container bridge', async () => {
            // The whole failure: inside the app container the only interface IS
            // the bridge, so nothing in the interface list can be right.
            interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
            const ws = makeWebServer('192.168.1.107:80');
            await ws.init();
            expect(ws.getLanIP()).toBe('192.168.1.107');
        });

        it('beats a NATed socket address reported by a device', async () => {
            // With the app container NATed, our end of the device socket is the
            // container's own address — useless to the device, which reaches
            // Homey on its LAN address.
            interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
            const ws = makeWebServer('192.168.1.107:80');
            await ws.init();
            ws.reportReachableIp('172.17.0.2');
            expect(ws.getLanIP()).toBe('192.168.1.107');
        });

        it('loses to a device-reported address that is a real LAN address', async () => {
            // That address is the source of a connection that reaches the device,
            // so it is right by construction even if Homey names another one.
            interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
            const ws = makeWebServer('192.168.1.107:80');
            await ws.init();
            ws.reportReachableIp('192.168.2.50');
            expect(ws.getLanIP()).toBe('192.168.2.50');
        });

        it('keeps a non-80 port so the URL points at the right listener', async () => {
            interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
            const ws = makeWebServer('192.168.1.107:8080');
            await ws.init();
            expect(ws.buildStaticUrl('listening_chime.flac'))
                .toBe('http://192.168.1.107:8080/app/no.arvebjoe.ai-voice-assistant/userdata/audio/listening_chime.flac');
        });

        it('ignores an answer that is not an IPv4 address', async () => {
            interfacesMock.mockReturnValue({ eth0: iface('192.168.1.107') });
            const ws = makeWebServer('homey-1234.local:80');
            await ws.init();
            expect(ws.getLanIP()).toBe('192.168.1.107');
        });

        it('falls back to sniffing when Homey cannot answer', async () => {
            interfacesMock.mockReturnValue({ eth0: iface('192.168.1.107') });
            const ws = makeWebServer(async () => { throw new Error('Homey is offline'); });
            await ws.init();
            expect(ws.getLanIP()).toBe('192.168.1.107');
        });

        it('does not let a hanging cloud manager block app boot', async () => {
            // init() awaits this call; a manager that never answers must not
            // stall the whole app's onInit behind it.
            vi.useFakeTimers();
            try {
                interfacesMock.mockReturnValue({ eth0: iface('192.168.1.107') });
                const ws = makeWebServer(() => new Promise<string>(() => { /* never settles */ }));
                const init = ws.init();
                await vi.advanceTimersByTimeAsync(5_000);
                await init;
                expect(ws.getLanIP()).toBe('192.168.1.107');
            } finally {
                vi.useRealTimers();
            }
        });

        it('loses to the HE_HOST_IP override', async () => {
            interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
            process.env.HE_HOST_IP = '10.0.0.5';
            const ws = makeWebServer('192.168.1.107:80');
            await ws.init();
            expect(ws.getLanIP()).toBe('10.0.0.5');
        });
    });

    it('builds audio URLs from the reported address', async () => {
        interfacesMock.mockReturnValue({ eth0: iface('172.17.0.2') });
        const ws = makeWebServer();
        ws.reportReachableIp('192.168.1.107');
        expect(ws.buildStaticUrl('listening_chime.flac'))
            .toBe('http://192.168.1.107/app/no.arvebjoe.ai-voice-assistant/userdata/audio/listening_chime.flac');
    });
});
