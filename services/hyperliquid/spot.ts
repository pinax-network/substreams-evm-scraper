import { insertClient } from '../../lib/clickhouse';
import { createLogger } from '../../lib/logger';
import { incrementError } from '../../lib/prometheus';
import { nowRefreshTime } from './refresh-time';
import {
    fetchSpotMeta,
    type HyperliquidSpotMeta,
    resolvePairNames,
} from './spot-info';

const serviceName = 'hyperliquid';
const log = createLogger(`${serviceName}:spot`);

/**
 * Fetch the latest spot universe + tokens, resolve `@N` pair names into their
 * `BASE/QUOTE` market names with split base/quote token symbols, and snapshot
 * all rows into `state_spot_pair_names` with a fresh `refresh_time`. Caller
 * (the combined `hyperliquid` service in index.ts) orchestrates with the
 * outcomes poller in one cycle.
 */
export async function runSpotCycle(infoUrl: string): Promise<void> {
    log.info('Fetching spot metadata');
    const startTime = performance.now();

    let meta: HyperliquidSpotMeta;
    try {
        meta = await fetchSpotMeta(infoUrl);
    } catch (error) {
        log.error('Failed to fetch spot metadata', { error });
        incrementError(serviceName);
        throw error;
    }

    const fetchTimeMs = Math.round(performance.now() - startTime);
    const rows = resolvePairNames(meta);

    log.info('Resolved spot pair names', {
        pairs: meta.universe.length,
        tokens: meta.tokens.length,
        rows: rows.length,
        fetchTimeMs,
    });

    if (rows.length === 0) {
        log.warn('Empty spot universe — skipping insert');
        return;
    }

    const refresh_time = nowRefreshTime();
    const values = rows.map((r) => ({ ...r, refresh_time }));

    try {
        await insertClient.insert({
            table: 'state_spot_pair_names',
            values,
            format: 'JSONEachRow',
        });
    } catch (error) {
        log.error('Failed to insert spot pair names', { error });
        incrementError(serviceName);
        throw error;
    }

    log.info('Inserted spot pair names', { count: values.length });
}
