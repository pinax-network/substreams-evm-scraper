import { afterEach, describe, expect, mock, test } from 'bun:test';
import {
    fetchSpotMeta,
    type HyperliquidSpotMeta,
    resolvePairNames,
} from './spot-info';

describe('resolvePairNames', () => {
    test('passes canonical pair name through unchanged', () => {
        const meta: HyperliquidSpotMeta = {
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
                    name: 'PURR',
                    fullName: null,
                    index: 1,
                    tokenId: '0x01',
                    szDecimals: 0,
                    weiDecimals: 5,
                    isCanonical: true,
                    evmContract: null,
                    deployerTradingFeeShare: '0.0',
                },
            ],
            universe: [
                {
                    tokens: [1, 0],
                    name: 'PURR/USDC',
                    index: 0,
                    isCanonical: true,
                },
            ],
        };
        expect(resolvePairNames(meta)).toEqual([
            {
                coin: 'PURR/USDC',
                market_name: 'PURR/USDC',
                base_token: 'PURR',
                quote_token: 'USDC',
            },
        ]);
    });

    test('resolves @N pair name from token indexes', () => {
        const meta: HyperliquidSpotMeta = {
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
                    fullName: 'Hyperliquid',
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
        expect(resolvePairNames(meta)).toEqual([
            {
                coin: '@107',
                market_name: 'HYPE/USDC',
                base_token: 'HYPE',
                quote_token: 'USDC',
            },
        ]);
    });

    test('skips @N pairs that reference unknown token indexes', () => {
        const meta: HyperliquidSpotMeta = {
            tokens: [],
            universe: [
                {
                    tokens: [150, 0],
                    name: '@107',
                    index: 107,
                    isCanonical: false,
                },
            ],
        };
        expect(resolvePairNames(meta)).toEqual([]);
    });

    test('processes mixed canonical and auction-deployed pairs', () => {
        const meta: HyperliquidSpotMeta = {
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
                    name: 'PURR',
                    fullName: null,
                    index: 1,
                    tokenId: '0x01',
                    szDecimals: 0,
                    weiDecimals: 5,
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
                    tokens: [1, 0],
                    name: 'PURR/USDC',
                    index: 0,
                    isCanonical: true,
                },
                {
                    tokens: [150, 0],
                    name: '@107',
                    index: 107,
                    isCanonical: false,
                },
            ],
        };
        expect(resolvePairNames(meta)).toEqual([
            {
                coin: 'PURR/USDC',
                market_name: 'PURR/USDC',
                base_token: 'PURR',
                quote_token: 'USDC',
            },
            {
                coin: '@107',
                market_name: 'HYPE/USDC',
                base_token: 'HYPE',
                quote_token: 'USDC',
            },
        ]);
    });
});

describe('fetchSpotMeta', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('parses a well-formed spotMeta response', async () => {
        const body: HyperliquidSpotMeta = {
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
            ],
            universe: [],
        };
        globalThis.fetch = mock(() =>
            Promise.resolve(
                new Response(JSON.stringify(body), { status: 200 }),
            ),
        ) as unknown as typeof fetch;
        const got = await fetchSpotMeta('http://example/info');
        expect(got).toEqual(body);
    });

    test('throws on non-2xx response', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response('nope', { status: 500 })),
        ) as unknown as typeof fetch;
        await expect(fetchSpotMeta('http://example/info')).rejects.toThrow(
            /HTTP 500/,
        );
    });

    test('throws when response is missing tokens or universe', async () => {
        globalThis.fetch = mock(() =>
            Promise.resolve(new Response('{}', { status: 200 })),
        ) as unknown as typeof fetch;
        await expect(fetchSpotMeta('http://example/info')).rejects.toThrow(
            /missing tokens\/universe/,
        );
    });
});
