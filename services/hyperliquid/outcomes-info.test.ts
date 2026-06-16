import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
    buildLiveOutcomeRow,
    buildOutcomeToQuestion,
    buildQuestionRow,
    buildSettledOutcomeRow,
    extractSettledQuestionId,
    fetchOutcomeMeta,
    fetchSettledOutcome,
    type HyperliquidOutcomeMeta,
    type HyperliquidOutcomeSpec,
    type HyperliquidQuestion,
    type HyperliquidSettledOutcome,
} from './outcomes-info';

const REFRESH = '2026-06-11 12:00:00.000';

const liveOutcome: HyperliquidOutcomeSpec = {
    outcome: 104,
    name: 'June Fed rate change',
    description: 'Resolves to Change if ...',
    sideSpecs: [{ name: 'Change' }, { name: 'No Change' }],
    quoteToken: 'USDC',
};

const worldCupQuestion: HyperliquidQuestion = {
    question: 32,
    name: '2026 World Cup Champion',
    description: 'Each associated outcome ...',
    fallbackOutcome: 171,
    namedOutcomes: [172, 173, 174],
    settledNamedOutcomes: [],
};

describe('buildOutcomeToQuestion', () => {
    test('maps namedOutcomes and fallbackOutcome to their parent question', () => {
        const map = buildOutcomeToQuestion([worldCupQuestion]);
        expect(map.get(171)).toBe(32);
        expect(map.get(172)).toBe(32);
        expect(map.get(173)).toBe(32);
        expect(map.get(174)).toBe(32);
        expect(map.has(999)).toBe(false);
    });

    test('handles a question with a null fallbackOutcome', () => {
        const q: HyperliquidQuestion = {
            ...worldCupQuestion,
            fallbackOutcome: null,
            namedOutcomes: [200, 201],
        };
        const map = buildOutcomeToQuestion([q]);
        expect(map.get(200)).toBe(32);
        expect(map.get(201)).toBe(32);
        expect(map.size).toBe(2);
    });

    test('returns an empty map for zero questions', () => {
        expect(buildOutcomeToQuestion([]).size).toBe(0);
    });
});

describe('buildLiveOutcomeRow', () => {
    test('flattens sideSpecs and marks status=live', () => {
        const row = buildLiveOutcomeRow(liveOutcome, null, REFRESH);
        expect(row).toEqual({
            outcome_id: 104,
            question_id: null,
            name: 'June Fed rate change',
            description: 'Resolves to Change if ...',
            side_specs: ['Change', 'No Change'],
            quote_token: 'USDC',
            status: 'live',
            settle_fraction: null,
            settle_details: null,
            refresh_time: REFRESH,
        });
    });

    test('carries through a parent question_id when supplied', () => {
        const row = buildLiveOutcomeRow(
            { ...liveOutcome, outcome: 172 },
            32,
            REFRESH,
        );
        expect(row.question_id).toBe(32);
    });
});

describe('buildSettledOutcomeRow', () => {
    const settled: HyperliquidSettledOutcome = {
        spec: {
            outcome: 0,
            name: 'Recurring',
            description:
                'class:priceBinary|underlying:BTC|expiry:20260503-0600|targetPrice:78213|period:1d',
            sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
            quoteToken: 'USDH',
        },
        settleFraction: '0.0',
        details: 'price:78212.4',
    };

    test('parses settleFraction to float and marks status=settled', () => {
        const row = buildSettledOutcomeRow(settled, null, REFRESH);
        expect(row.status).toBe('settled');
        expect(row.settle_fraction).toBe(0);
        expect(row.settle_details).toBe('price:78212.4');
        expect(row.outcome_id).toBe(0);
        expect(row.name).toBe('Recurring');
        expect(row.quote_token).toBe('USDH');
        expect(row.side_specs).toEqual(['Yes', 'No']);
    });

    test('preserves scalar settleFraction values', () => {
        const row = buildSettledOutcomeRow(
            { ...settled, settleFraction: '0.42' },
            null,
            REFRESH,
        );
        expect(row.settle_fraction).toBe(0.42);
    });

    test('coerces a non-numeric settleFraction to null instead of NaN', () => {
        const row = buildSettledOutcomeRow(
            { ...settled, settleFraction: 'bogus' },
            null,
            REFRESH,
        );
        expect(row.settle_fraction).toBeNull();
    });
});

describe('extractSettledQuestionId', () => {
    const baseSettled: HyperliquidSettledOutcome = {
        spec: {
            outcome: 318,
            name: 'Germany',
            description: 'Resolves to Yes if Germany wins the Game.',
            sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
            quoteToken: 'USDC',
        },
        settleFraction: '1.0',
        details: 'FIFA declared Germany the winner.',
    };

    test('returns the settled question id when the parent question has fully resolved', () => {
        const settled: HyperliquidSettledOutcome = {
            ...baseSettled,
            question: {
                question: { settled: 54 },
                name: 'World Cup: Germany vs Curacao',
                description: '...',
            },
        };
        expect(extractSettledQuestionId(settled)).toBe(54);
    });

    test('returns the live question id when the parent question is still ongoing', () => {
        const settled: HyperliquidSettledOutcome = {
            ...baseSettled,
            question: {
                question: { live: 32 },
                name: '2026 World Cup Champion',
                description: '...',
            },
        };
        expect(extractSettledQuestionId(settled)).toBe(32);
    });

    test('returns null for binary single-outcome markets (no question wrapper)', () => {
        expect(extractSettledQuestionId(baseSettled)).toBeNull();
    });

    test('returns null when the wrapper is present but the discriminator is empty', () => {
        const settled: HyperliquidSettledOutcome = {
            ...baseSettled,
            question: { question: {}, name: '', description: '' },
        };
        expect(extractSettledQuestionId(settled)).toBeNull();
    });
});

describe('buildQuestionRow', () => {
    test('flattens question metadata into the row shape', () => {
        expect(buildQuestionRow(worldCupQuestion, REFRESH)).toEqual({
            question_id: 32,
            name: '2026 World Cup Champion',
            description: 'Each associated outcome ...',
            fallback_outcome_id: 171,
            named_outcome_ids: [172, 173, 174],
            settled_outcome_ids: [],
            refresh_time: REFRESH,
        });
    });

    test('preserves a null fallbackOutcome', () => {
        const row = buildQuestionRow(
            { ...worldCupQuestion, fallbackOutcome: null },
            REFRESH,
        );
        expect(row.fallback_outcome_id).toBeNull();
    });
});

describe('fetchOutcomeMeta', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('parses a well-formed outcomeMeta response', async () => {
        const body: HyperliquidOutcomeMeta = {
            outcomes: [liveOutcome],
            questions: [worldCupQuestion],
        };
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify(body), { status: 200 }),
            ),
        ) as unknown as typeof fetch;
        const got = await fetchOutcomeMeta('http://example/info');
        expect(got).toEqual(body);
    });

    test('throws on non-2xx response', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response('nope', { status: 500 })),
        ) as unknown as typeof fetch;
        await expect(fetchOutcomeMeta('http://example/info')).rejects.toThrow(
            /HTTP 500/,
        );
    });

    test('throws when outcomes or questions are missing', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ outcomes: [] }), { status: 200 }),
            ),
        ) as unknown as typeof fetch;
        await expect(fetchOutcomeMeta('http://example/info')).rejects.toThrow(
            /missing outcomes\/questions/,
        );
    });
});

describe('fetchSettledOutcome', () => {
    const originalFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('returns null when HL responds with top-level null (still live)', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response('null', { status: 200 })),
        ) as unknown as typeof fetch;
        expect(
            await fetchSettledOutcome('http://example/info', 104),
        ).toBeNull();
    });

    test('returns the spec + settlement when present', async () => {
        const body: HyperliquidSettledOutcome = {
            spec: {
                outcome: 0,
                name: 'Recurring',
                description: 'class:priceBinary|underlying:BTC',
                sideSpecs: [{ name: 'Yes' }, { name: 'No' }],
                quoteToken: 'USDH',
            },
            settleFraction: '1.0',
            details: 'price:80000.0',
        };
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify(body), { status: 200 }),
            ),
        ) as unknown as typeof fetch;
        expect(await fetchSettledOutcome('http://example/info', 0)).toEqual(
            body,
        );
    });

    test('returns null on malformed payload (missing settleFraction)', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify({ spec: liveOutcome }), {
                    status: 200,
                }),
            ),
        ) as unknown as typeof fetch;
        expect(await fetchSettledOutcome('http://example/info', 1)).toBeNull();
    });

    test('throws on non-2xx response', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response('boom', { status: 503 })),
        ) as unknown as typeof fetch;
        await expect(
            fetchSettledOutcome('http://example/info', 1),
        ).rejects.toThrow(/HTTP 503/);
    });
});
