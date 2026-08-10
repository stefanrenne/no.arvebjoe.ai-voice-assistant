import { EspVoiceAssistantClient } from './esp-voice-assistant-client.mjs';

/**
 * One-shot capability probe of an ESPHome device over the native API.
 *
 * This is the single implementation of "connect, wait for the identity +
 * capability handshake, disconnect" that both the pairing flow
 * (VoiceAssistantDriver) and the Debug settings page (seen-devices list) use,
 * so the star in the debug list means exactly what pairing means by "found a
 * matching device".
 *
 * The probe is deliberately model-agnostic: it reports what the device said
 * (deviceType + the three capability counts) and lets the caller decide
 * whether that matches the driver it belongs to.
 */

export type EspProbeStatus =
    /** Answered the handshake and has the voice-assistant capabilities. */
    | 'accessible'
    /** Answered, but is not a voice satellite (no media player / VA support). */
    | 'not_a_match'
    /** Refused plaintext — the device has an API encryption key configured. */
    | 'requires_encryption'
    /** The Noise handshake failed; `code` carries the precise reason. */
    | 'encryption_error'
    /** The connection dropped / never came up. */
    | 'unreachable'
    /** Nothing answered before the deadline. */
    | 'timeout';

export interface EspProbeResult {
    status: EspProbeStatus;
    /** 'pe' | 'tr' | 'respeaker' | 'xiaozhi' — null when it never identified itself. */
    deviceType: string | null;
    mediaPlayers: number;
    subscribeVoiceAssistant: number;
    voiceAssistantConfiguration: number;
    /** MAC as reported in the handshake (empty until DeviceInfoResponse arrives). */
    mac: string;
    /** Friendly name as reported in the handshake. */
    friendlyName: string;
    /**
     * For 'encryption_error': the precise code from the client
     * ('wrong_key' | 'plaintext_device' | 'mac_mismatch' | 'invalid_key' |
     * 'protocol_error'). Empty otherwise.
     */
    code: string;
    /** Human-readable detail for the debug UI ('' when there is nothing to add). */
    message: string;
}

export interface EspProbeOptions {
    host: string;
    port?: number;
    /** ESPHome API encryption key (base64). Runs the probe over Noise when set. */
    encryptionKey?: string;
    /** MAC to verify against the Noise server hello (only used with a key). */
    expectedMac?: string;
    timeoutMs?: number;
    /** Test seam: build the client (defaults to a real EspVoiceAssistantClient). */
    createClient?: (opts: any) => any;
}

/** A device is "accessible" when it can actually serve as a voice satellite. */
function isVoiceCapable(mediaPlayers: number, subscribeVa: number, vaConfig: number): boolean {
    return mediaPlayers > 0 && subscribeVa > 0 && vaConfig > 0;
}

export async function probeEspDevice(homey: any, options: EspProbeOptions): Promise<EspProbeResult> {
    const { host, port = 6053, encryptionKey, expectedMac, timeoutMs = 5000 } = options;
    const createClient = options.createClient
        ?? ((opts: any) => new EspVoiceAssistantClient(homey, opts));

    let client: any = null;
    let done = false;
    let timeoutHandle: any = null;

    return new Promise<EspProbeResult>((resolve) => {
        const finish = async (result: EspProbeResult) => {
            if (done) return;
            done = true;

            if (timeoutHandle !== null) {
                homey.clearTimeout(timeoutHandle);
                timeoutHandle = null;
            }

            // Detach first: a teardown-triggered 'Unhealthy' must not overwrite
            // the outcome we just settled on.
            try {
                client?.off?.('capabilities', onCapabilities);
                client?.off?.('Unhealthy', onUnhealthy);
                client?.off?.('requires_encryption', onRequiresEncryption);
                client?.off?.('encryption_error', onEncryptionError);
            } catch { /* the client may already be gone */ }

            try {
                if (client) await client.disconnect();
            } catch { /* best effort */ }
            client = null;

            resolve(result);
        };

        const identity = () => ({
            mac: (client?.getMacAddress?.() as string) || '',
            friendlyName: (client?.getFriendlyName?.() as string) || '',
        });

        const onCapabilities = (
            mediaPlayers: number,
            subscribeVa: number,
            vaConfig: number,
            deviceType: string | null,
        ) => {
            const capable = isVoiceCapable(mediaPlayers, subscribeVa, vaConfig);
            void finish({
                status: capable ? 'accessible' : 'not_a_match',
                deviceType: deviceType ?? null,
                mediaPlayers,
                subscribeVoiceAssistant: subscribeVa,
                voiceAssistantConfiguration: vaConfig,
                ...identity(),
                code: '',
                message: capable ? '' : 'Answered, but has no voice-assistant capabilities',
            });
        };

        const onUnhealthy = () => {
            void finish(emptyResult('unreachable', '', 'Connection failed or dropped'));
        };

        const onRequiresEncryption = () => {
            void finish(emptyResult('requires_encryption', '', 'The device has an API encryption key set'));
        };

        const onEncryptionError = (code: string, message: string) => {
            void finish(emptyResult('encryption_error', code || 'protocol_error', message || code || ''));
        };

        const emptyResult = (status: EspProbeStatus, code: string, message: string): EspProbeResult => ({
            status,
            deviceType: null,
            mediaPlayers: 0,
            subscribeVoiceAssistant: 0,
            voiceAssistantConfiguration: 0,
            ...identity(),
            code,
            message,
        });

        try {
            client = createClient({
                host,
                apiPort: port,
                discoveryMode: true,
                encryptionKey: encryptionKey || undefined,
                expectedMac: encryptionKey ? (expectedMac || undefined) : undefined,
            });

            client.on('capabilities', onCapabilities);
            client.on?.('Unhealthy', onUnhealthy);
            client.on?.('requires_encryption', onRequiresEncryption);
            client.on?.('encryption_error', onEncryptionError);

            Promise.resolve(client.start())
                .catch(() => finish(emptyResult('unreachable', '', 'Could not open a connection')));

            timeoutHandle = homey.setTimeout(
                () => { void finish(emptyResult('timeout', '', `No answer within ${timeoutMs} ms`)); },
                timeoutMs,
            );
            timeoutHandle?.unref?.();
        } catch {
            // finish() also tears down a half-constructed client.
            void finish(emptyResult('unreachable', '', 'Could not open a connection'));
        }
    });
}
