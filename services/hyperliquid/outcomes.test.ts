import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

const mockInsert = mock(() => Promise.resolve());
const mockQuery = mock(() =>
    Promise.resolve({
        data: [] as { outcome_id: string }[],
        metrics: { httpRequestTimeMs: 0, dataFetchTimeMs: 0, totalTimeMs: 0 },
    }),
);
const mockIncrementSuccess = mock(() => {});
const mockIncrementError = mock(() => {});
const mockMarkServiceAlive = mock(() => {});

mock.module('../../lib/clickhouse', () => ({
    insertClient: { insert: mockInsert },
    query: mockQuery,
}));

mock.module('../../lib/prometheus', () => ({
    incrementSuccess: mockIncrementSuccess,
    incrementError: mockIncrementError,
}));

// `mock.module` applies process-wide for the test session. Mirror the full set
// of exports other test files mock so a later `mock.module` call in another
// suite can't leave dangling undefined imports for whichever test runs last.
mock.module('../../lib/service-init', () => ({
    initService: mock(() => {}),
    markServiceAlive: mockMarkServiceAlive,
}));

const liveBody = {
    outcomes: [
        {
            outcome: 104,
            name: 'June Fed rate change',
            description: 'Resolves to ...',
            sideSpecs: [{ name: 'Change' }, { name: 'No Change' }],
            quoteToken: 'USDC',
        },
        {
            outcome: 172,
            name: 'Algeria',
            description: 'Resolves Yes if ...',
            sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
            quoteToken: 'USDC',
        },
    ],
    questions: [
        {
            question: 32,
            name: '2026 World Cup Champion',
            description: 'Each ...',
            fallbackOutcome: 171,
            namedOutcomes: [172],
            settledNamedOutcomes: [],
        },
    ],
};

const settledBody = {
    spec: {
        outcome: 0,
        name: 'Recurring',
        description: 'class:priceBinary|underlying:BTC',
        sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
        quoteToken: 'USDH',
    },
    settleFraction: '0.0',
    details: 'price:78212.4',
};

interface InsertCallArg {
    table: string;
    values: Array<Record<string, unknown>>;
    format: string;
}

function mockQueryRouter(routes: {
    knownIds?: string[];
    alreadySettled?: string[];
}) {
    return (sql: string) => {
        let rows: { outcome_id: string }[] = [];
        if (sql.includes('outcome_fills')) {
            rows = (routes.knownIds ?? []).map((id) => ({ outcome_id: id }));
        } else if (sql.includes('state_outcome_meta')) {
            rows = (routes.alreadySettled ?? []).map((id) => ({
                outcome_id: id,
            }));
        }
        return Promise.resolve({
            data: rows,
            metrics: {
                httpRequestTimeMs: 0,
                dataFetchTimeMs: 0,
                totalTimeMs: 0,
            },
        });
    };
}

describe('hyperliquid runOutcomesCycle()', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
        mockInsert.mockClear();
        mockQuery.mockClear();
        mockIncrementSuccess.mockClear();
        mockIncrementError.mockClear();
        mockMarkServiceAlive.mockClear();
        mockQuery.mockImplementation(() =>
            Promise.resolve({
                data: [] as { outcome_id: string }[],
                metrics: {
                    httpRequestTimeMs: 0,
                    dataFetchTimeMs: 0,
                    totalTimeMs: 0,
                },
            }),
        );
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('inserts live + settled outcomes and questions in one cycle', async () => {
        mockQuery.mockImplementation(
            mockQueryRouter({
                knownIds: ['104', '172', '0'],
                alreadySettled: [],
            }),
        );

        globalThis.fetch = mock((_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (body.type === 'outcomeMeta') {
                return Promise.resolve(
                    new Response(JSON.stringify(liveBody), { status: 200 }),
                );
            }
            if (body.type === 'settledOutcome' && body.outcome === 0) {
                return Promise.resolve(
                    new Response(JSON.stringify(settledBody), { status: 200 }),
                );
            }
            return Promise.resolve(new Response('null', { status: 200 }));
        }) as unknown as typeof fetch;

        const { runOutcomesCycle } = await import('./outcomes');
        await runOutcomesCycle('http://example/info');

        expect(mockInsert).toHaveBeenCalledTimes(2);
        const calls = mockInsert.mock.calls.map((c) => c[0] as InsertCallArg);

        const outcomeCall = calls.find((c) => c.table === 'state_outcome_meta');
        const questionCall = calls.find(
            (c) => c.table === 'state_question_meta',
        );
        expect(outcomeCall).toBeDefined();
        expect(questionCall).toBeDefined();
        expect(outcomeCall!.format).toBe('JSONEachRow');

        expect(outcomeCall!.values).toHaveLength(3);
        const live104 = outcomeCall!.values.find((r) => r.outcome_id === 104);
        const settled0 = outcomeCall!.values.find((r) => r.outcome_id === 0);
        const live172 = outcomeCall!.values.find((r) => r.outcome_id === 172);
        expect(live104?.status).toBe('live');
        expect(settled0?.status).toBe('settled');
        expect(settled0?.settle_fraction).toBe(0);
        expect(settled0?.settle_details).toBe('price:78212.4');
        expect(live172?.question_id).toBe(32);
        expect(live104?.question_id).toBeNull();

        expect(questionCall!.values).toHaveLength(1);
        expect(questionCall!.values[0]!.question_id).toBe(32);

        // The orchestrator (index.ts run()) is responsible for the success
        // metric + heartbeat once BOTH sub-cycles complete; this sub-cycle
        // must not advance them on its own.
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
        expect(mockIncrementError).not.toHaveBeenCalled();
        expect(mockMarkServiceAlive).not.toHaveBeenCalled();
    });

    test('proceeds when known-ids query fails (cold cluster)', async () => {
        mockQuery.mockImplementation(() =>
            Promise.reject(new Error('table not found')),
        );
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify(liveBody), { status: 200 }),
            ),
        ) as unknown as typeof fetch;

        const { runOutcomesCycle } = await import('./outcomes');
        await runOutcomesCycle('http://example/info');

        expect(mockInsert).toHaveBeenCalledTimes(2);
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
        expect(mockIncrementError).not.toHaveBeenCalled();
    });

    test('continues past per-id settledOutcome failures without aborting the cycle', async () => {
        mockQuery.mockImplementation(
            mockQueryRouter({
                knownIds: ['999'],
                alreadySettled: [],
            }),
        );
        globalThis.fetch = mock((_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (body.type === 'outcomeMeta') {
                return Promise.resolve(
                    new Response(JSON.stringify(liveBody), { status: 200 }),
                );
            }
            return Promise.resolve(new Response('boom', { status: 502 }));
        }) as unknown as typeof fetch;

        const { runOutcomesCycle } = await import('./outcomes');
        await runOutcomesCycle('http://example/info');

        expect(mockInsert).toHaveBeenCalledTimes(2);
        const outcomeCall = mockInsert.mock.calls
            .map((c) => c[0] as InsertCallArg)
            .find((c) => c.table === 'state_outcome_meta');
        expect(outcomeCall!.values).toHaveLength(2);
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
    });

    test('skips settledOutcome probes for ids already captured as settled', async () => {
        mockQuery.mockImplementation(
            mockQueryRouter({
                knownIds: ['104', '172', '0'],
                alreadySettled: ['0'],
            }),
        );
        const settledProbed: number[] = [];
        globalThis.fetch = mock((_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (body.type === 'outcomeMeta') {
                return Promise.resolve(
                    new Response(JSON.stringify(liveBody), { status: 200 }),
                );
            }
            if (body.type === 'settledOutcome') {
                settledProbed.push(body.outcome);
            }
            return Promise.resolve(new Response('null', { status: 200 }));
        }) as unknown as typeof fetch;

        const { runOutcomesCycle } = await import('./outcomes');
        await runOutcomesCycle('http://example/info');

        expect(settledProbed).toEqual([]);
        const outcomeCall = mockInsert.mock.calls
            .map((c) => c[0] as InsertCallArg)
            .find((c) => c.table === 'state_outcome_meta');
        expect(outcomeCall!.values).toHaveLength(2);
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
        expect(mockMarkServiceAlive).not.toHaveBeenCalled();
    });

    test('recovers question_id from settledOutcome wrapper when live map has no entry', async () => {
        // outcome 318 (Germany) belonged to question 54 (Germany vs Curacao),
        // which has fully settled and dropped from outcomeMeta. The live map
        // can't link it back, but the settledOutcome response still carries
        // the parent question id under `question.question.settled`.
        mockQuery.mockImplementation(
            mockQueryRouter({
                knownIds: ['318'],
                alreadySettled: [],
            }),
        );
        globalThis.fetch = mock((_url: string, init: RequestInit) => {
            const body = JSON.parse(init.body as string);
            if (body.type === 'outcomeMeta') {
                return Promise.resolve(
                    new Response(JSON.stringify(liveBody), { status: 200 }),
                );
            }
            if (body.type === 'settledOutcome' && body.outcome === 318) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            spec: {
                                outcome: 318,
                                name: 'Germany',
                                description: 'Resolves Yes if Germany wins.',
                                sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
                                quoteToken: 'USDC',
                            },
                            settleFraction: '1.0',
                            details: 'FIFA declared Germany the winner.',
                            question: {
                                question: { settled: 54 },
                                name: 'World Cup: Germany vs Curacao',
                                description:
                                    'This market has three possible outcomes...',
                            },
                        }),
                        { status: 200 },
                    ),
                );
            }
            return Promise.resolve(new Response('null', { status: 200 }));
        }) as unknown as typeof fetch;

        const { runOutcomesCycle } = await import('./outcomes');
        await runOutcomesCycle('http://example/info');

        const outcomeCall = mockInsert.mock.calls
            .map((c) => c[0] as InsertCallArg)
            .find((c) => c.table === 'state_outcome_meta');
        const settled318 = outcomeCall!.values.find(
            (r) => r.outcome_id === 318,
        );
        expect(settled318?.status).toBe('settled');
        expect(settled318?.question_id).toBe(54);
    });

    test('returns early without inserting when outcomeMeta is empty', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ outcomes: [], questions: [] }), {
                    status: 200,
                }),
            ),
        ) as unknown as typeof fetch;

        const { runOutcomesCycle } = await import('./outcomes');
        await runOutcomesCycle('http://example/info');

        expect(mockInsert).not.toHaveBeenCalled();
        expect(mockIncrementSuccess).not.toHaveBeenCalled();
        expect(mockIncrementError).not.toHaveBeenCalled();
        expect(mockMarkServiceAlive).not.toHaveBeenCalled();
    });

    test('records an error metric and rethrows when outcomeMeta fetch fails', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response('nope', { status: 502 })),
        ) as unknown as typeof fetch;

        const { runOutcomesCycle } = await import('./outcomes');
        await expect(runOutcomesCycle('http://example/info')).rejects.toThrow();
        expect(mockIncrementError).toHaveBeenCalledTimes(1);
        expect(mockInsert).not.toHaveBeenCalled();
        expect(mockMarkServiceAlive).not.toHaveBeenCalled();
    });
});
