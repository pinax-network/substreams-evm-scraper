/**
 * Format a `DateTime64(3, 'UTC')`-compatible timestamp shared by every
 * scraper-managed table in the hyperliquid service (`state_spot_pair_names`,
 * `state_outcome_meta`, `state_question_meta`).
 *
 * ClickHouse rejects the trailing `Z` on `DateTime64` literals but accepts
 * the millisecond fraction; we preserve ms so closely-spaced polls produce
 * distinct `refresh_time` values for deterministic ReplacingMergeTree merges.
 *
 * Both sub-cycles call this once per insert pass, and the format must stay
 * in lockstep across the three tables — keep the single source of truth here.
 */
export function nowRefreshTime(): string {
    return new Date().toISOString().slice(0, 23).replace('T', ' ');
}
