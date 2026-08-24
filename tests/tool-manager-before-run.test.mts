import { describe, it, expect, beforeEach } from 'vitest';
import { ToolManager } from '../src/llm/tool-manager.mjs';
import { MockHomey } from './mocks/mock-homey.mjs';
import { MockDeviceManager } from './mocks/mock-device-manager.mjs';
import { MockGeoHelper } from './mocks/mock-geo-helper.mjs';
import { MockWeatherHelper } from './mocks/mock-weather-helper.mjs';
import { settingsManager } from '../src/settings/settings-manager.mjs';

// Tools read device/zone state, so the turn's refetch must land BEFORE a handler
// runs. It cannot be awaited in a 'tool.called' listener — the providers emit and
// then call execute() on the next line, and emit() ignores async listeners — so
// the wait lives in execute() itself.
describe('ToolManager beforeRun hook', () => {
    let toolManager: ToolManager;

    beforeEach(async () => {
        settingsManager.reset();
        const deviceManager = new MockDeviceManager();
        await deviceManager.init();
        await deviceManager.fetchData();
        settingsManager.init(new MockHomey());
        toolManager = new ToolManager(new MockHomey(), 'Office', deviceManager as any, new MockGeoHelper() as any, new MockWeatherHelper() as any);
    });

    it('awaits the hook before the handler runs', async () => {
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });

        toolManager.setBeforeRun(async () => { await gate; order.push('refetch'); });
        toolManager.registerTool({
            type: 'function', name: 'probe', description: 'test',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
            handler: async () => { order.push('handler'); return { ok: true }; },
        });

        const run = toolManager.execute('probe', {});
        await Promise.resolve();
        expect(order).toEqual([]);   // still blocked on the hook

        release();
        await run;
        expect(order).toEqual(['refetch', 'handler']);
    });

    it('runs the tool anyway when the hook rejects', async () => {
        // A failed refetch leaves a stale catalog, which is still workable —
        // refusing the tool would turn a slow API into a broken assistant.
        toolManager.setBeforeRun(async () => { throw new Error('API down'); });
        toolManager.registerTool({
            type: 'function', name: 'probe', description: 'test',
            parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
            handler: async () => ({ ok: true }),
        });

        const { output, failed } = await toolManager.execute('probe', {});
        expect(failed).toBe(false);
        expect(output).toEqual({ ok: true });
    });

    it('works with no hook set', async () => {
        const { output } = await toolManager.execute('get_zones', {});
        expect((output as any).ok).toBe(true);
    });
});
