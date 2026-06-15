import { createLogger } from '../../lib/logger';
import { incrementSuccess } from '../../lib/prometheus';
import { initService, markServiceAlive } from '../../lib/service-init';
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
 * so there's no ordering constraint.
 *
 * Liveness contract: `markServiceAlive()` + `incrementSuccess()` only fire
 * after BOTH sub-cycles complete without throwing. A partial success — e.g.
 * spot snapshot lands but outcomes fetch fails — must not advance the
 * heartbeat, otherwise `/live` would report healthy while the service is
 * silently flapping. Per-cycle error metrics still fire from inside each
 * sub-cycle's catch block before the throw propagates.
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
        // Heartbeat must NOT advance on a partial- or full-failure cycle:
        // a successful sub-cycle alone is not enough to claim the service
        // is healthy. Surface every failure so the supervisor's stack
        // trace doesn't silently drop the second error when both
        // sub-cycles reject — per-cycle error metrics already fired from
        // inside each cycle's catch block.
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, 'hyperliquid cycle failed');
    }

    // Both sub-cycles completed (either inserted or early-returned on
    // empty/cold-cluster). Mark the cycle a success: bump the wall-clock
    // heartbeat so `/live` reflects progress (we insert directly via
    // `insertClient` rather than the batch-insert queue, so the queue's
    // `getLastSuccessfulFlushAt()` never advances on its own) and increment
    // the per-service success metric.
    markServiceAlive();
    incrementSuccess(serviceName);
}

if (import.meta.main) {
    await run();
}
