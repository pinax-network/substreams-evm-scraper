import { createLogger } from '../../lib/logger';

/**
 * Per-request timeout for Hyperliquid Info API calls. Shared with the spotMeta
 * service via the same env var so both pollers tolerate the same upstream
 * slowness budget. Falls back to 30s if the override is missing or invalid.
 */
const FETCH_TIMEOUT_MS = (() => {
    const parsed = Number.parseInt(
        process.env.HYPERLIQUID_FETCH_TIMEOUT_MS ?? '',
        10,
    );
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 30000;
})();

const log = createLogger('hyperliquid-outcomes');

/**
 * One outcome entry as returned by `POST /info {type: outcomeMeta}` and (under
 * `spec`) by `POST /info {type: settledOutcome, outcome: N}`.
 *
 * `sideSpecs` is positional — `side_index` on `outcome_fills` indexes directly
 * into this array. Typical shapes: `[{name:'Yes'},{name:'No'}]` for binary
 * outcomes, or domain-specific labels like `[{name:'Change'},{name:'No Change'}]`.
 */
export interface HyperliquidOutcomeSpec {
    outcome: number;
    name: string;
    description: string;
    sideSpecs: Array<{ name: string }>;
    quoteToken: string;
}

/**
 * One question entry — multi-outcome grouping like a "World Cup Champion"
 * question that aggregates per-team outcomes.
 *
 * `namedOutcomes` lists the outcome ids that compose the question;
 * `fallbackOutcome` is the outcome id used when none of the named ones resolve
 * YES; `settledNamedOutcomes` is the subset already resolved.
 */
export interface HyperliquidQuestion {
    question: number;
    name: string;
    description: string;
    fallbackOutcome: number | null;
    namedOutcomes: number[];
    settledNamedOutcomes: number[];
}

export interface HyperliquidOutcomeMeta {
    outcomes: HyperliquidOutcomeSpec[];
    questions: HyperliquidQuestion[];
}

/**
 * Settlement payload returned by `POST /info {type: settledOutcome, outcome: N}`
 * when the outcome has resolved. Returns `null` (top-level) for outcomes still
 * live — callers must distinguish that case before parsing.
 */
export interface HyperliquidSettledOutcome {
    spec: HyperliquidOutcomeSpec;
    settleFraction: string;
    details: string;
}

/** Row shape inserted into `state_outcome_meta`. */
export interface OutcomeMetaRow {
    outcome_id: number;
    question_id: number | null;
    name: string;
    description: string;
    side_specs: string[];
    quote_token: string;
    status: 'live' | 'settled';
    settle_fraction: number | null;
    settle_details: string | null;
    refresh_time: string;
}

/** Row shape inserted into `state_question_meta`. */
export interface QuestionMetaRow {
    question_id: number;
    name: string;
    description: string;
    fallback_outcome_id: number | null;
    named_outcome_ids: number[];
    settled_outcome_ids: number[];
    refresh_time: string;
}

async function postInfo<T>(
    infoUrl: string,
    body: Record<string, unknown>,
): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(infoUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(
                `Hyperliquid /info returned HTTP ${response.status}`,
            );
        }
        return (await response.json()) as T;
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Fetch the live outcome universe + question groupings. `outcomes` only
 * contains outcomes whose markets are still open — settled outcomes drop off
 * and must be recovered via `fetchSettledOutcome`.
 */
export async function fetchOutcomeMeta(
    infoUrl: string,
): Promise<HyperliquidOutcomeMeta> {
    const body = await postInfo<HyperliquidOutcomeMeta>(infoUrl, {
        type: 'outcomeMeta',
    });
    if (!Array.isArray(body.outcomes) || !Array.isArray(body.questions)) {
        throw new Error(
            'Hyperliquid /info outcomeMeta response missing outcomes/questions arrays',
        );
    }
    return body;
}

/**
 * Recover a settled outcome's spec + resolution payload. Returns `null` when
 * the outcome is still live (HL returns top-level `null`).
 */
export async function fetchSettledOutcome(
    infoUrl: string,
    outcomeId: number,
): Promise<HyperliquidSettledOutcome | null> {
    const body = await postInfo<HyperliquidSettledOutcome | null>(infoUrl, {
        type: 'settledOutcome',
        outcome: outcomeId,
    });
    if (body === null) return null;
    if (
        typeof body !== 'object' ||
        body.spec === undefined ||
        typeof body.settleFraction !== 'string'
    ) {
        log.warn('settledOutcome response missing expected fields', {
            outcomeId,
        });
        return null;
    }
    return body;
}

/**
 * Build the reverse index from outcome_id → parent question_id. Walks each
 * question's `namedOutcomes` + `fallbackOutcome` and records the question id
 * for every referenced outcome. An outcome can only belong to one question on
 * the HL side, so last-write-wins is fine (and not exercised in practice).
 */
export function buildOutcomeToQuestion(
    questions: HyperliquidQuestion[],
): Map<number, number> {
    const map = new Map<number, number>();
    for (const q of questions) {
        for (const id of q.namedOutcomes) map.set(id, q.question);
        if (q.fallbackOutcome !== null) {
            map.set(q.fallbackOutcome, q.question);
        }
    }
    return map;
}

/** Project a live `outcomeMeta` outcome into a `state_outcome_meta` row. */
export function buildLiveOutcomeRow(
    outcome: HyperliquidOutcomeSpec,
    questionId: number | null,
    refreshTime: string,
): OutcomeMetaRow {
    return {
        outcome_id: outcome.outcome,
        question_id: questionId,
        name: outcome.name,
        description: outcome.description,
        side_specs: outcome.sideSpecs.map((s) => s.name),
        quote_token: outcome.quoteToken,
        status: 'live',
        settle_fraction: null,
        settle_details: null,
        refresh_time: refreshTime,
    };
}

/**
 * Project a `settledOutcome` response into a `state_outcome_meta` row.
 * Re-uses the spec embedded in the settlement payload so name/description
 * survive after the outcome drops out of the live universe.
 *
 * `settleFraction` comes off the wire as a string ("0.0" / "1.0" / scalar);
 * we coerce to Float64. Non-numeric strings produce `null` so a malformed
 * payload doesn't poison the row.
 */
export function buildSettledOutcomeRow(
    settled: HyperliquidSettledOutcome,
    questionId: number | null,
    refreshTime: string,
): OutcomeMetaRow {
    const fraction = Number.parseFloat(settled.settleFraction);
    return {
        outcome_id: settled.spec.outcome,
        question_id: questionId,
        name: settled.spec.name,
        description: settled.spec.description,
        side_specs: settled.spec.sideSpecs.map((s) => s.name),
        quote_token: settled.spec.quoteToken,
        status: 'settled',
        settle_fraction: Number.isFinite(fraction) ? fraction : null,
        settle_details: settled.details,
        refresh_time: refreshTime,
    };
}

/** Project a question into a `state_question_meta` row. */
export function buildQuestionRow(
    question: HyperliquidQuestion,
    refreshTime: string,
): QuestionMetaRow {
    return {
        question_id: question.question,
        name: question.name,
        description: question.description,
        fallback_outcome_id: question.fallbackOutcome,
        named_outcome_ids: question.namedOutcomes,
        settled_outcome_ids: question.settledNamedOutcomes,
        refresh_time: refreshTime,
    };
}
