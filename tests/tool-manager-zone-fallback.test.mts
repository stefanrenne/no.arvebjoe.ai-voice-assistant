import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

// The "nothing here" fallback: get_devices_in_standard_zone finds no device of
// the asked-for type in the satellite's own zone and falls back to the ONE
// other zone that has them (setting `zone_fallback_enabled`, default on).
// Mock data: blinds/curtains exist only in Office; lights exist in 4 zones.
describe('ToolManager zone fallback', () => {
    let toolManager: ToolManager;
    let deviceManager: MockDeviceManager;
    let mockHomey: MockHomey;
    let listStandardZone: (args: any) => Promise<any>;
    let setCapability: (args: any) => Promise<any>;

    async function build(standardZone: string) {
        toolManager = new ToolManager(mockHomey, standardZone, deviceManager as any, new MockGeoHelper() as any, new MockWeatherHelper() as any);
        listStandardZone = toolManager.getToolHandlers()['get_devices_in_standard_zone'];
        setCapability = toolManager.getToolHandlers()['set_device_capability'];
    }

    beforeEach(async () => {
        settingsManager.reset();
        mockHomey = new MockHomey();
        deviceManager = new MockDeviceManager();
        await deviceManager.init();
        await deviceManager.fetchData();
        settingsManager.init(mockHomey);
        // The satellite stands in the Kitchen, which has no window coverings.
        await build('Kitchen');
    });

    it('falls back to the only other zone that has that device type', async () => {
        const res = await listStandardZone({ type: 'blinds' });
        expect(res.ok).toBe(true);
        expect(res.data.devices.map((d: any) => d.id)).toEqual(['device-16']);
        expect(res.meta.scope).toBe('other_zone');
        expect(res.meta.zone).toBe('Office');
        expect(res.meta.standard_zone).toBe('Kitchen');
    });

    it('does not fall back when the standard zone has matches of its own', async () => {
        const res = await listStandardZone({ type: 'light' });
        expect(res.ok).toBe(true);
        expect(res.data.devices.every((d: any) => d.zone === 'Kitchen')).toBe(true);
        expect(res.meta).toBeUndefined();
    });

    it('refuses to fall back when several zones have that device type', async () => {
        // A second blind, in another zone -> ambiguous, keep the old behavior.
        deviceManager.addDevice({
            id: 'device-99', name: 'Terrace Sunshade', zone: 'Terrace', zones: ['Terrace'],
            type: 'blinds', capabilities: ['windowcoverings_set=1'], dataId: 'mac-099',
        } as any);

        const res = await listStandardZone({ type: 'blinds' });
        expect(res.ok).toBe(true);
        expect(res.data.devices).toEqual([]);
        expect(res.meta).toBeUndefined();
    });

    it('does not fall back when the setting is off', async () => {
        mockHomey.settings.set('zone_fallback_enabled', false);
        const res = await listStandardZone({ type: 'blinds' });
        expect(res.ok).toBe(true);
        expect(res.data.devices).toEqual([]);
        expect(res.meta).toBeUndefined();
    });

    it('lets the write through for the devices the fallback handed back', async () => {
        // Without the fallback the cross-zone guard blocks an Office device.
        let res = await setCapability({ deviceIds: ['device-16'], capabilityId: 'windowcoverings_set', newValue: 0 });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('CROSS_ZONE_BLOCKED');

        await listStandardZone({ type: 'blinds' });

        res = await setCapability({ deviceIds: ['device-16'], capabilityId: 'windowcoverings_set', newValue: 0 });
        expect(res.ok).toBe(true);
        expect(res.meta.cross_zone_blocked).toBe(0);
    });

    it('still blocks other zones than the one the fallback pointed at', async () => {
        await listStandardZone({ type: 'blinds' });
        // device-12 is an Office light — not part of the fallback result.
        const res = await setCapability({ deviceIds: ['device-12'], capabilityId: 'onoff', newValue: false });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('CROSS_ZONE_BLOCKED');
    });

    it('drops the grant when the satellite moves to another zone', async () => {
        await listStandardZone({ type: 'blinds' });
        toolManager.setStandardZone('Bedroom');
        const res = await setCapability({ deviceIds: ['device-16'], capabilityId: 'windowcoverings_set', newValue: 0 });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('CROSS_ZONE_BLOCKED');
    });

    // "Close the blinds and the curtains" is two type-locked listings in one
    // utterance. The grant must accumulate: replacing it revoked the first
    // listing and dropped that device from the write while still reporting ok.
    it('keeps the earlier grant when a second fallback fires in the same turn', async () => {
        await listStandardZone({ type: 'blinds' });   // grants device-16
        await listStandardZone({ type: 'curtain' });  // grants device-17

        const blinds = await setCapability({ deviceIds: ['device-16'], capabilityId: 'windowcoverings_set', newValue: 0 });
        expect(blinds.ok).toBe(true);
        expect(blinds.meta.cross_zone_blocked).toBe(0);

        const curtains = await setCapability({ deviceIds: ['device-17'], capabilityId: 'windowcoverings_state', newValue: 'down' });
        expect(curtains.ok).toBe(true);
        expect(curtains.meta.cross_zone_blocked).toBe(0);
    });

    it('writes both devices in one call after two fallbacks', async () => {
        await listStandardZone({ type: 'blinds' });
        await listStandardZone({ type: 'curtain' });

        const res = await setCapability({ deviceIds: ['device-16', 'device-17'], capabilityId: 'windowcoverings_set', newValue: 0 });
        expect(res.ok).toBe(true);
        expect(res.meta.deduplicated).toBe(2);
        expect(res.meta.cross_zone_blocked).toBe(0);
    });

    // Two distinct zones can share a display name (upstairs/downstairs
    // "Office"). Grouping on the name collapses them and grants writes across
    // both physical rooms; the full zone path keeps them apart.
    it('refuses to fall back when two same-named zones both have that type', async () => {
        deviceManager.addDevice({
            id: 'device-98', name: 'Upstairs Office Blinds', zone: 'Office', zones: ['Office', 'Upstairs'],
            type: 'blinds', capabilities: ['windowcoverings_set=1'], dataId: 'mac-098',
        } as any);

        const res = await listStandardZone({ type: 'blinds' });
        expect(res.ok).toBe(true);
        expect(res.data.devices).toEqual([]);
        expect(res.meta).toBeUndefined();

        const write = await setCapability({ deviceIds: ['device-98'], capabilityId: 'windowcoverings_set', newValue: 0 });
        expect(write.ok).toBe(false);
        expect(write.error.code).toBe('CROSS_ZONE_BLOCKED');
    });

    // The grant serves the utterance that earned it, not the whole session.
    it('expires the grant after the TTL', async () => {
        vi.useFakeTimers();
        try {
            await listStandardZone({ type: 'blinds' });

            let res = await setCapability({ deviceIds: ['device-16'], capabilityId: 'windowcoverings_set', newValue: 0 });
            expect(res.ok).toBe(true);

            vi.advanceTimersByTime(3 * 60_000);

            res = await setCapability({ deviceIds: ['device-16'], capabilityId: 'windowcoverings_set', newValue: 1 });
            expect(res.ok).toBe(false);
            expect(res.error.code).toBe('CROSS_ZONE_BLOCKED');
        } finally {
            vi.useRealTimers();
        }
    });

    it('revokes an existing grant when the setting is turned off mid-session', async () => {
        await listStandardZone({ type: 'blinds' });
        mockHomey.settings.set('zone_fallback_enabled', false);

        const res = await setCapability({ deviceIds: ['device-16'], capabilityId: 'windowcoverings_set', newValue: 0 });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe('CROSS_ZONE_BLOCKED');
    });

    // The fallback searches house-wide, so it must not dump every match into a
    // single tool result; page_size applies and `fb:` tokens continue the list.
    describe('paging', () => {
        beforeEach(() => {
            deviceManager.addDevice({
                id: 'device-97', name: 'Office Blinds 2', zone: 'Office', zones: ['Office'],
                type: 'blinds', capabilities: ['windowcoverings_set=1'], dataId: 'mac-097',
            } as any);
        });

        it('honors page_size and hands back a continuation token', async () => {
            const first = await listStandardZone({ type: 'blinds', page_size: 1 });
            expect(first.ok).toBe(true);
            expect(first.data.devices.map((d: any) => d.id)).toEqual(['device-16']);
            expect(first.data.next_page_token).toBe('fb:1');
            expect(first.meta.scope).toBe('other_zone');

            const second = await listStandardZone({ type: 'blinds', page_size: 1, page_token: first.data.next_page_token });
            expect(second.ok).toBe(true);
            expect(second.data.devices.map((d: any) => d.id)).toEqual(['device-97']);
            expect(second.data.next_page_token).toBeNull();
            expect(second.meta.scope).toBe('other_zone');
        });

        it('grants the write for every device of the fallback, paged or not', async () => {
            await listStandardZone({ type: 'blinds', page_size: 1 });
            const res = await setCapability({ deviceIds: ['device-16', 'device-97'], capabilityId: 'windowcoverings_set', newValue: 0 });
            expect(res.ok).toBe(true);
            expect(res.meta.cross_zone_blocked).toBe(0);
        });

        it('reports a stale page token instead of silently answering the wrong list', async () => {
            const res = await listStandardZone({ type: 'curtain', page_token: 'fb:1' });
            expect(res.ok).toBe(false);
            expect(res.error.code).toBe('PAGE_TOKEN_EXPIRED');
        });
    });
});
