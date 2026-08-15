import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger, setVerboseLogging, isVerboseLogging } from '../src/helpers/logger.mjs';

// The verbose switch decides whether loggers created `disabled: true` (ESP,
// AGENT, PE, the device itself) write to the app log. They are exactly the
// loggers that say whether the satellite link and the AI engine connected, and
// exactly the ones missing from a submitted log — see setVerboseLogging().

function mockHomey() {
    return { log: vi.fn(), error: vi.fn() } as any;
}

/** Lines this logger wrote to the app log (details lines included). */
function linesFrom(homey: any): string[] {
    return homey.log.mock.calls.map((c: any[]) => String(c[0]));
}

describe('verbose logging', () => {
    afterEach(() => {
        // Module-level flag: leaking it on would change every later test's output.
        setVerboseLogging(false);
    });

    it('is off by default, so a quieted logger stays silent', () => {
        const homey = mockHomey();
        const quiet = createLogger('QUIET-A', true);
        quiet.setHomey(homey);

        quiet.info('ESP Voice Client healthy');

        expect(isVerboseLogging()).toBe(false);
        expect(linesFrom(homey).some((l) => l.includes('ESP Voice Client healthy'))).toBe(false);
    });

    it('lets a quieted logger through once switched on', () => {
        const homey = mockHomey();
        const quiet = createLogger('QUIET-B', true);
        quiet.setHomey(homey);

        setVerboseLogging(true);
        quiet.info('Agent connection opened');

        expect(isVerboseLogging()).toBe(true);
        expect(linesFrom(homey).some((l) => l.includes('Agent connection opened'))).toBe(true);
    });

    it('goes quiet again when switched back off', () => {
        const homey = mockHomey();
        const quiet = createLogger('QUIET-C', true);
        quiet.setHomey(homey);

        setVerboseLogging(true);
        quiet.info('while on');
        setVerboseLogging(false);
        quiet.info('while off');

        const lines = linesFrom(homey);
        expect(lines.some((l) => l.includes('while on'))).toBe(true);
        expect(lines.some((l) => l.includes('while off'))).toBe(false);
    });

    it('announces both transitions, and only on a real change', () => {
        // Without this a reader cannot tell "switched off" from "the subsystem
        // stopped saying anything".
        const homey = mockHomey();
        createLogger('ANNOUNCE', true).setHomey(homey);

        setVerboseLogging(true);
        setVerboseLogging(true);   // no-op: already on
        setVerboseLogging(false);

        const announcements = linesFrom(homey).filter((l) => l.includes('Verbose logging'));
        expect(announcements.length).toBe(2);
        expect(announcements[0]).toContain('ON');
        expect(announcements[1]).toContain('OFF');
    });

    it('does not change normal loggers, which were never quieted', () => {
        const homey = mockHomey();
        const normal = createLogger('LOUD');
        normal.setHomey(homey);

        normal.info('conversation event');
        setVerboseLogging(true);
        normal.info('another event');

        const lines = linesFrom(homey);
        expect(lines.filter((l) => l.includes('event')).length).toBe(2);
    });

    it('still writes warnings and errors from a quieted logger while off', () => {
        // `disabled` only ever silenced info(); the switch must not change that.
        const homey = mockHomey();
        const quiet = createLogger('QUIET-D', true);
        quiet.setHomey(homey);

        quiet.warn('RX buffer exceeded limit');

        expect(linesFrom(homey).some((l) => l.includes('RX buffer exceeded limit'))).toBe(true);
    });
});
