import { createLogger } from '../../lib/logger';
import { initService } from '../../lib/service-init';
import { runOutcomesCycle } from './outcomes';
import { runSpotCycle } from './spot';

const serviceName = 'hyperliquid';
const log = createLogger(serviceName);

/**
 * Combined Hyperliquid scraper. One cycle runs both the spot-pair-names
 * snapshot (`state_spot_pair_names`) and the HIP-4 outcome / question
 * metadata snapshot (`state_outcome_meta` + `state_question_meta`) against
 * the same HL Info endpoint and ClickHouse database.
 *
 * Both sub-cycles share `HYPERLIQUID_INFO_URL` + the global CH client. They
 * run in parallel — they hit independent Info endpoints and disjoint tables,
 * so there's no ordering constraint. A failure in either propagates after
 * both complete (or the slow one is still in flight when the other errors).
 *
 * The CLI runner loops with `AUTO_RESTART_DELAY` between cycles, so a single
 * `run()` invocation maps to one poll cycle.
 */
export async function run(): Promise<void> {
    initService({ serviceName });

    const infoUrl = process.env.HYPERLIQUID_INFO_URL;
    if (!infoUrl) {
        throw new Error(
            'HYPERLIQUID_INFO_URL is required (set to a Hyperliquid /info endpoint)',
        );
    }

    const results = await Promise.allSettled([
        runSpotCycle(infoUrl),
        runOutcomesCycle(infoUrl),
    ]);

    const errors = results
        .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
        .map((r) => r.reason);

    if (errors.length > 0) {
        log.error('Cycle completed with failures', {
            spot: results[0].status,
            outcomes: results[1].status,
            errors: errors.map((e) =>
                e instanceof Error ? e.message : String(e),
            ),
        });
        // Surface the first error so the supervisor can backoff/restart.
        throw errors[0];
    }
}

if (import.meta.main) {
    await run();
}
