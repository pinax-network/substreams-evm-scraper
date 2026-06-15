import PQueue from 'p-queue';
import { insertClient, query } from '../../lib/clickhouse';
import { createLogger } from '../../lib/logger';
import { incrementError } from '../../lib/prometheus';
import {
    buildLiveOutcomeRow,
    buildOutcomeToQuestion,
    buildQuestionRow,
    buildSettledOutcomeRow,
    fetchOutcomeMeta,
    fetchSettledOutcome,
    type OutcomeMetaRow,
    type QuestionMetaRow,
} from './outcomes-info';

const serviceName = 'hyperliquid';
const log = createLogger(`${serviceName}:outcomes`);

/**
 * Max in-flight `settledOutcome` lookups per cycle. Cold-start probes ~200
 * settled ids against api.hyperliquid.xyz; default 4 keeps us well under
 * HL's per-IP allowance while finishing the cold-start sweep in ~50s.
 */
const SETTLED_CONCURRENCY = (() => {
    const parsed = Number.parseInt(
        process.env.HL_OUTCOMES_SETTLED_CONCURRENCY ?? '',
        10,
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 4;
})();

/**
 * Discover all `outcome_id`s the substream has ever written into the live DB.
 * Settled outcomes drop out of `outcomeMeta`, so this is the only source of
 * truth for which ids need a `settledOutcome` probe.
 */
async function fetchKnownOutcomeIds(): Promise<Set<number>> {
    const { data } = await query<{ outcome_id: string }>(
        'SELECT DISTINCT toString(outcome_id) AS outcome_id FROM outcome_fills',
    );
    return parseUint64Set(data);
}

/**
 * Discover outcome_ids we've already captured as `status='settled'`. Settled
 * payloads are immutable on the HL side, so once we have one we never need to
 * re-probe — skipping them turns the steady-state cycle into a no-op on the
 * Info API even as the cumulative settled universe grows.
 */
async function fetchAlreadySettledIds(): Promise<Set<number>> {
    const { data } = await query<{ outcome_id: string }>(
        "SELECT toString(outcome_id) AS outcome_id FROM state_outcome_meta FINAL WHERE status = 'settled'",
    );
    return parseUint64Set(data);
}

function parseUint64Set(rows: { outcome_id: string }[]): Set<number> {
    const ids = new Set<number>();
    for (const row of rows) {
        const n = Number.parseInt(row.outcome_id, 10);
        if (Number.isFinite(n)) ids.add(n);
    }
    return ids;
}

/**
 * Format a `DateTime64(3, 'UTC')`-compatible timestamp. CH rejects the
 * trailing `Z` but accepts the millisecond fraction, and we preserve ms so
 * closely-spaced polls remain deterministic for RMT merges (same convention
 * as the sibling `hyperliquid` service).
 */
function nowRefreshTime(): string {
    return new Date().toISOString().slice(0, 23).replace('T', ' ');
}

/**
 * One outcome-meta poll cycle:
 *   1. Pull `outcomeMeta` (live outcomes + question groupings).
 *   2. Read distinct `outcome_id` from `outcome_fills` to discover settled
 *      outcomes not in the live snapshot.
 *   3. For each settled id, `settledOutcome` lookup (concurrency-bounded).
 *   4. Insert all rows with a single `refresh_time`. RMT collapses repeated
 *      rows on subsequent polls.
 *
 * Caller (the combined `hyperliquid` service in index.ts) orchestrates with
 * the spot poller in one cycle.
 */
export async function runOutcomesCycle(infoUrl: string): Promise<void> {
    log.info('Fetching outcome metadata');
    const startTime = performance.now();

    let meta: Awaited<ReturnType<typeof fetchOutcomeMeta>>;
    try {
        meta = await fetchOutcomeMeta(infoUrl);
    } catch (error) {
        log.error('Failed to fetch outcomeMeta', { error });
        incrementError(serviceName);
        throw error;
    }

    const liveIds = new Set(meta.outcomes.map((o) => o.outcome));
    log.info('Fetched live outcomeMeta', {
        outcomes: meta.outcomes.length,
        questions: meta.questions.length,
    });

    if (meta.outcomes.length === 0 && meta.questions.length === 0) {
        // Empty universe is unusual (HL has had standing outcomes for months).
        // Treat as a soft failure: don't bump the success counter, don't
        // overwrite live rows on RMT, but also don't error-throw — next
        // cycle will retry.
        log.warn('outcomeMeta returned empty outcomes and questions');
        return;
    }

    // Cold cluster (`outcome_fills` empty/absent) is non-fatal — proceed
    // with just the live snapshot so the first cycle still records the
    // current universe.
    const knownIds = await fetchKnownOutcomeIds().catch((error) => {
        log.warn(
            'Failed to read known outcome_ids — proceeding with live only',
            { error },
        );
        return new Set<number>();
    });
    const alreadySettled = await fetchAlreadySettledIds().catch((error) => {
        log.warn('Failed to read already-settled outcome_ids — will re-probe', {
            error,
        });
        return new Set<number>();
    });

    const settledIds = [...knownIds].filter(
        (id) => !liveIds.has(id) && !alreadySettled.has(id),
    );
    log.info('Resolved outcome universe', {
        known: knownIds.size,
        live: liveIds.size,
        alreadySettled: alreadySettled.size,
        settledLookups: settledIds.length,
        settledConcurrency: SETTLED_CONCURRENCY,
    });

    const refresh_time = nowRefreshTime();
    const outcomeToQuestion = buildOutcomeToQuestion(meta.questions);

    const outcomeRows: OutcomeMetaRow[] = meta.outcomes.map((o) =>
        buildLiveOutcomeRow(
            o,
            outcomeToQuestion.get(o.outcome) ?? null,
            refresh_time,
        ),
    );

    const queue = new PQueue({ concurrency: SETTLED_CONCURRENCY });
    let settledFetched = 0;
    let settledStillLive = 0;
    let settledErrored = 0;
    await Promise.all(
        settledIds.map((id) =>
            queue.add(async () => {
                try {
                    const s = await fetchSettledOutcome(infoUrl, id);
                    if (s === null) {
                        // HL returned `null` — outcome must have re-opened or
                        // is in a transient between-state. Skip; next cycle
                        // will retry naturally.
                        settledStillLive++;
                        return;
                    }
                    outcomeRows.push(
                        buildSettledOutcomeRow(
                            s,
                            outcomeToQuestion.get(s.spec.outcome) ?? null,
                            refresh_time,
                        ),
                    );
                    settledFetched++;
                } catch (error) {
                    // Per-id failures should not abort the whole cycle.
                    // Transient HL outages will retry on the next poll.
                    settledErrored++;
                    log.warn('settledOutcome lookup failed', {
                        outcomeId: id,
                        error,
                    });
                }
            }),
        ),
    );

    const questionRows: QuestionMetaRow[] = meta.questions.map((q) =>
        buildQuestionRow(q, refresh_time),
    );

    try {
        if (outcomeRows.length > 0) {
            await insertClient.insert({
                table: 'state_outcome_meta',
                values: outcomeRows,
                format: 'JSONEachRow',
            });
        }
        if (questionRows.length > 0) {
            await insertClient.insert({
                table: 'state_question_meta',
                values: questionRows,
                format: 'JSONEachRow',
            });
        }
    } catch (error) {
        log.error('Failed to insert outcome metadata', { error });
        incrementError(serviceName);
        throw error;
    }

    const cycleMs = Math.round(performance.now() - startTime);
    log.info('Inserted outcome metadata', {
        outcomeRows: outcomeRows.length,
        questionRows: questionRows.length,
        settledFetched,
        settledStillLive,
        settledErrored,
        cycleMs,
    });
}
