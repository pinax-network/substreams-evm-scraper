import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockInsert = mock(() => Promise.resolve());
const mockQuery = mock(() =>
    Promise.resolve({
        data: [],
        metrics: { httpRequestTimeMs: 0, dataFetchTimeMs: 0, totalTimeMs: 0 },
    }),
);
const mockIncrementSuccess = mock(() => {});
const mockIncrementError = mock(() => {});

mock.module('../../lib/clickhouse', () => ({
    insertClient: { insert: mockInsert },
    query: mockQuery,
}));

mock.module('../../lib/prometheus', () => ({
    incrementSuccess: mockIncrementSuccess,
    incrementError: mockIncrementError,
}));

// `mock.module` is process-wide; ensure other tests importing the orchestrator
// or outcomes via this module name don't see missing exports if this suite
// happens to run last.
mock.module('../../lib/service-init', () => ({
    initService: mock(() => {}),
    markServiceAlive: mock(() => {}),
}));

const sampleMeta = {
    tokens: [
        {
            name: 'USDC',
            fullName: null,
            index: 0,
            tokenId: '0x00',
            szDecimals: 8,
            weiDecimals: 8,
            isCanonical: true,
            evmContract: null,
            deployerTradingFeeShare: '0.0',
        },
        {
            name: 'HYPE',
            fullName: null,
            index: 150,
            tokenId: '0x96',
            szDecimals: 2,
            weiDecimals: 8,
            isCanonical: false,
            evmContract: null,
            deployerTradingFeeShare: '0.0',
        },
    ],
    universe: [
        {
            tokens: [150, 0],
            name: '@107',
            index: 107,
            isCanonical: false,
        },
    ],
};

describe('hyperliquid runSpotCycle()', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        mockInsert.mockClear();
        mockIncrementSuccess.mockClear();
        mockIncrementError.mockClear();
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('inserts resolved spot pair names with refresh_time', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify(sampleMeta), { status: 200 }),
            ),
        ) as unknown as typeof fetch;

        const { runSpotCycle } = await import('./spot');
        await runSpotCycle('http://example/info');

        expect(mockInsert).toHaveBeenCalledTimes(1);
        const arg = mockInsert.mock.calls[0]![0] as {
            table: string;
            values: Array<{
                coin: string;
                market_name: string;
                base_token: string;
                quote_token: string;
                refresh_time: string;
            }>;
            format: string;
        };
        expect(arg.table).toBe('state_spot_pair_names');
        expect(arg.format).toBe('JSONEachRow');
        expect(arg.values).toHaveLength(1);
        expect(arg.values[0]!.coin).toBe('@107');
        expect(arg.values[0]!.market_name).toBe('HYPE/USDC');
        expect(arg.values[0]!.base_token).toBe('HYPE');
        expect(arg.values[0]!.quote_token).toBe('USDC');
        expect(arg.values[0]!.refresh_time).toMatch(
            /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}$/,
        );
        // The orchestrator (index.ts run()) is responsible for the success
        // metric + heartbeat once BOTH sub-cycles complete; this sub-cycle
        // must not advance them on its own.
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
        expect(mockIncrementError).not.toHaveBeenCalled();
    });

    test('records an error metric and rethrows when fetch fails', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response('boom', { status: 502 })),
        ) as unknown as typeof fetch;

        const { runSpotCycle } = await import('./spot');
        await expect(runSpotCycle('http://example/info')).rejects.toThrow();
        expect(mockIncrementError).toHaveBeenCalledTimes(1);
        expect(mockInsert).not.toHaveBeenCalled();
    });
});
