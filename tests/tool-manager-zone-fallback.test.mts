import { describe, it, expect, beforeEach } from 'vitest';
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
});
