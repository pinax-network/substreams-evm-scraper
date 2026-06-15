import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockRunSpot = mock((_url: string) => Promise.resolve());
const mockRunOutcomes = mock((_url: string) => Promise.resolve());
const mockInitService = mock(() => {});

mock.module('./spot', () => ({ runSpotCycle: mockRunSpot }));
mock.module('./outcomes', () => ({ runOutcomesCycle: mockRunOutcomes }));
mock.module('../../lib/service-init', () => ({
    initService: mockInitService,
    markServiceAlive: mock(() => {}),
}));

describe('hyperliquid run() — combined orchestrator', () => {
    const originalUrl = process.env.HYPERLIQUID_INFO_URL;

    beforeEach(() => {
        mockRunSpot.mockClear();
        mockRunOutcomes.mockClear();
        mockInitService.mockClear();
        mockRunSpot.mockImplementation(() => Promise.resolve());
        mockRunOutcomes.mockImplementation(() => Promise.resolve());
    });

    afterEach(() => {
        if (originalUrl === undefined) {
            delete process.env.HYPERLIQUID_INFO_URL;
        } else {
            process.env.HYPERLIQUID_INFO_URL = originalUrl;
        }
    });

    test('throws when HYPERLIQUID_INFO_URL is unset', async () => {
        delete process.env.HYPERLIQUID_INFO_URL;
        const { run } = await import('./index');
        await expect(run()).rejects.toThrow(/HYPERLIQUID_INFO_URL/);
        expect(mockRunSpot).not.toHaveBeenCalled();
        expect(mockRunOutcomes).not.toHaveBeenCalled();
    });

    test('runs spot + outcomes cycles in parallel with the configured info URL', async () => {
        process.env.HYPERLIQUID_INFO_URL = 'http://example/info';

        const { run } = await import('./index');
        await run();

        expect(mockInitService).toHaveBeenCalledTimes(1);
        expect(mockRunSpot).toHaveBeenCalledTimes(1);
        expect(mockRunOutcomes).toHaveBeenCalledTimes(1);
        expect(mockRunSpot.mock.calls[0]![0]).toBe('http://example/info');
        expect(mockRunOutcomes.mock.calls[0]![0]).toBe('http://example/info');
    });

    test('surfaces the first error when one sub-cycle fails', async () => {
        process.env.HYPERLIQUID_INFO_URL = 'http://example/info';
        mockRunOutcomes.mockImplementation(() =>
            Promise.reject(new Error('outcomes boom')),
        );

        const { run } = await import('./index');
        await expect(run()).rejects.toThrow('outcomes boom');

        // Both sub-cycles still attempted — failure in one must not short-circuit
        // the other (`Promise.allSettled` semantics).
        expect(mockRunSpot).toHaveBeenCalledTimes(1);
        expect(mockRunOutcomes).toHaveBeenCalledTimes(1);
    });

    test('both failures still surface — first error wins', async () => {
        process.env.HYPERLIQUID_INFO_URL = 'http://example/info';
        mockRunSpot.mockImplementation(() =>
            Promise.reject(new Error('spot boom')),
        );
        mockRunOutcomes.mockImplementation(() =>
            Promise.reject(new Error('outcomes boom')),
        );

        const { run } = await import('./index');
        await expect(run()).rejects.toThrow('spot boom');
    });
});
