import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockRunSpot = mock((_url: string) => Promise.resolve());
const mockRunOutcomes = mock((_url: string) => Promise.resolve());
const mockInitService = mock(() => {});
const mockMarkServiceAlive = mock(() => {});
const mockIncrementSuccess = mock(() => {});
const mockIncrementError = mock(() => {});

mock.module('./spot', () => ({ runSpotCycle: mockRunSpot }));
mock.module('./outcomes', () => ({ runOutcomesCycle: mockRunOutcomes }));
mock.module('../../lib/service-init', () => ({
    initService: mockInitService,
    markServiceAlive: mockMarkServiceAlive,
}));
mock.module('../../lib/prometheus', () => ({
    incrementSuccess: mockIncrementSuccess,
    incrementError: mockIncrementError,
}));

describe('hyperliquid run() — combined orchestrator', () => {
    const originalUrl = process.env.HYPERLIQUID_INFO_URL;

    beforeEach(() => {
        mockRunSpot.mockClear();
        mockRunOutcomes.mockClear();
        mockInitService.mockClear();
        mockMarkServiceAlive.mockClear();
        mockIncrementSuccess.mockClear();
        mockIncrementError.mockClear();
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
        expect(mockMarkServiceAlive).not.toHaveBeenCalled();
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
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

    test('advances heartbeat + success metric only when both sub-cycles succeed', async () => {
        process.env.HYPERLIQUID_INFO_URL = 'http://example/info';

        const { run } = await import('./index');
        await run();

        expect(mockMarkServiceAlive).toHaveBeenCalledTimes(1);
        expect(mockIncrementSuccess).toHaveBeenCalledTimes(1);
    });

    test('does NOT advance heartbeat when outcomes sub-cycle fails', async () => {
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
        // Liveness contract: partial success is not success. /live must reflect
        // that the service is degraded even though spot completed.
        expect(mockMarkServiceAlive).not.toHaveBeenCalled();
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
    });

    test('does NOT advance heartbeat when spot sub-cycle fails', async () => {
        process.env.HYPERLIQUID_INFO_URL = 'http://example/info';
        mockRunSpot.mockImplementation(() =>
            Promise.reject(new Error('spot boom')),
        );

        const { run } = await import('./index');
        await expect(run()).rejects.toThrow('spot boom');

        expect(mockMarkServiceAlive).not.toHaveBeenCalled();
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
    });

    test('both failures still surface — first error wins, no heartbeat', async () => {
        process.env.HYPERLIQUID_INFO_URL = 'http://example/info';
        mockRunSpot.mockImplementation(() =>
            Promise.reject(new Error('spot boom')),
        );
        mockRunOutcomes.mockImplementation(() =>
            Promise.reject(new Error('outcomes boom')),
        );

        const { run } = await import('./index');
        await expect(run()).rejects.toThrow('spot boom');

        expect(mockMarkServiceAlive).not.toHaveBeenCalled();
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
    });
});
