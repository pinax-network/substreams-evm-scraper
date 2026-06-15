#!/usr/bin/env bun
/**
 * Validate the outcome-metadata side of the consolidated `hyperliquid`
 * scraper deployment against whichever ClickHouse the env points at.
 *
 * Reports:
 *  - schema presence + column shape for `state_outcome_meta` /
 *    `state_question_meta`
 *  - row counts by `status` and total
 *  - coverage gap: distinct `outcome_id` values in `outcome_fills` that have
 *    no row in `state_outcome_meta`
 *  - refresh-time freshness (max `refresh_time`, lag from now())
 *  - question reverse-map sanity: every `named_outcome_ids` member is present
 *    in `state_outcome_meta` and points back at its question
 *
 * Env (same vars the scraper reads):
 *  - CLICKHOUSE_URL, CLICKHOUSE_USERNAME, CLICKHOUSE_PASSWORD
 *  - CLICKHOUSE_DATABASE (must be the DB containing `outcome_fills`)
 *
 * Exits 0 on PASS, 1 on FAIL. PASS = both tables present + coverage gap == 0.
 */
import { query } from '../lib/clickhouse';

interface ColumnRow {
    name: string;
    type: string;
}

interface CountByStatusRow {
    status: string;
    rows: string;
}

interface OutcomeRow {
    outcome_id: string;
    question_id: string | null;
}

interface QuestionRow {
    question_id: string;
    named_outcome_ids: number[];
}

interface FreshnessRow {
    max_refresh: string;
    lag_s: string;
}

let failures = 0;

function pass(msg: string) {
    console.log(`  ✓ ${msg}`);
}

function fail(msg: string) {
    console.log(`  ✗ ${msg}`);
    failures++;
}

async function checkSchema(table: string, expected: Record<string, string>) {
    console.log(`\n[schema] ${table}`);
    const { data } = await query<ColumnRow>(
        `SELECT name, type FROM system.columns WHERE database = currentDatabase() AND table = {table:String}`,
        { table },
    );
    if (data.length === 0) {
        fail(`${table} missing — schema not deployed?`);
        return;
    }
    const got = new Map(data.map((r) => [r.name, r.type]));
    for (const [col, type] of Object.entries(expected)) {
        const actual = got.get(col);
        if (!actual) fail(`column ${col} missing`);
        else if (!actual.includes(type))
            fail(
                `column ${col}: expected type containing "${type}", got "${actual}"`,
            );
        else pass(`${col} :: ${actual}`);
    }
}

async function checkRowCounts() {
    console.log('\n[rows] state_outcome_meta');
    const { data } = await query<CountByStatusRow>(
        `SELECT status, toString(count()) AS rows
           FROM state_outcome_meta FINAL
          GROUP BY status
          ORDER BY status`,
    );
    if (data.length === 0) {
        fail('state_outcome_meta is empty — scraper has not run yet');
        return;
    }
    let live = 0;
    let settled = 0;
    for (const r of data) {
        const n = Number.parseInt(r.rows, 10);
        if (!Number.isFinite(n)) {
            fail(`non-numeric row count "${r.rows}" for status "${r.status}"`);
            continue;
        }
        if (r.status === 'live') live = n;
        else if (r.status === 'settled') settled = n;
        else fail(`unexpected status "${r.status}" (vocab is live | settled)`);
    }
    pass(`live=${live}, settled=${settled}, total=${live + settled}`);

    const { data: qData } = await query<{ rows: string }>(
        `SELECT toString(count()) AS rows FROM state_question_meta FINAL`,
    );
    pass(`state_question_meta rows=${qData[0]?.rows ?? '0'}`);
}

async function checkCoverage() {
    console.log('\n[coverage] outcome_fills → state_outcome_meta');
    const { data } = await query<{ missing: string }>(
        `SELECT toString(count()) AS missing FROM (
           SELECT DISTINCT outcome_id FROM outcome_fills
         ) f
         LEFT JOIN (SELECT outcome_id FROM state_outcome_meta FINAL) m USING (outcome_id)
         WHERE m.outcome_id IS NULL`,
    );
    const missing = Number.parseInt(data[0]?.missing ?? '0', 10);
    if (!Number.isFinite(missing)) {
        fail(`non-numeric coverage gap "${data[0]?.missing}"`);
        return;
    }
    if (missing === 0)
        pass('every outcome_id in outcome_fills has a state_outcome_meta row');
    else fail(`${missing} outcome_ids in outcome_fills lack a meta row`);
}

async function checkFreshness() {
    console.log('\n[freshness] refresh_time lag');
    const { data } = await query<FreshnessRow>(
        `SELECT toString(max(refresh_time)) AS max_refresh,
                toString(toUInt32(dateDiff('second', max(refresh_time), now()))) AS lag_s
           FROM state_outcome_meta`,
    );
    const lag = Number.parseInt(data[0]?.lag_s ?? '999999', 10);
    if (!Number.isFinite(lag)) {
        fail(`non-numeric freshness lag "${data[0]?.lag_s}"`);
        return;
    }
    if (lag <= 900)
        pass(`max(refresh_time)=${data[0]?.max_refresh} (lag ${lag}s)`);
    else
        fail(
            `max(refresh_time)=${data[0]?.max_refresh} is ${lag}s old — scraper may be down`,
        );
}

async function checkQuestionRoundtrip() {
    console.log('\n[questions] reverse-map consistency');
    const { data: qs } = await query<QuestionRow>(
        `SELECT toString(question_id) AS question_id, named_outcome_ids
           FROM state_question_meta FINAL`,
    );
    if (qs.length === 0) {
        pass('no questions yet (vacuous)');
        return;
    }
    const { data: os } = await query<OutcomeRow>(
        `SELECT toString(outcome_id) AS outcome_id,
                if(isNull(question_id), NULL, toString(question_id)) AS question_id
           FROM state_outcome_meta FINAL`,
    );
    const outcomeQ = new Map(os.map((r) => [r.outcome_id, r.question_id]));
    let mismatches = 0;
    for (const q of qs) {
        for (const named of q.named_outcome_ids) {
            const got = outcomeQ.get(String(named));
            if (got === undefined) {
                fail(
                    `question ${q.question_id} references outcome ${named} which has no meta row`,
                );
                mismatches++;
            } else if (got !== q.question_id) {
                fail(
                    `outcome ${named}.question_id=${got ?? 'null'} but should be ${q.question_id}`,
                );
                mismatches++;
            }
        }
    }
    if (mismatches === 0)
        pass(`${qs.length} questions × namedOutcomes all back-resolved`);
}

await checkSchema('state_outcome_meta', {
    outcome_id: 'UInt64',
    question_id: 'Nullable(UInt64)',
    name: 'String',
    description: 'String',
    side_specs: 'Array(String)',
    quote_token: 'LowCardinality(String)',
    status: 'LowCardinality(String)',
    settle_fraction: 'Nullable(Float64)',
    settle_details: 'Nullable(String)',
    refresh_time: "DateTime64(3, 'UTC')",
});
await checkSchema('state_question_meta', {
    question_id: 'UInt64',
    name: 'String',
    description: 'String',
    fallback_outcome_id: 'Nullable(UInt64)',
    named_outcome_ids: 'Array(UInt64)',
    settled_outcome_ids: 'Array(UInt64)',
    refresh_time: "DateTime64(3, 'UTC')",
});

if (failures === 0) {
    await checkRowCounts();
    await checkCoverage();
    await checkFreshness();
    await checkQuestionRoundtrip();
}

console.log(`\n${failures === 0 ? 'PASS' : `FAIL (${failures})`}`);
process.exit(failures === 0 ? 0 : 1);
