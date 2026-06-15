import { describe, expect, test } from 'bun:test';
import {
    executeSqlSetup,
    splitSqlStatements,
    substituteQueryParams,
    transformSqlForCluster,
} from './setup';

describe('substituteQueryParams', () => {
    test('should substitute numeric parameters with type annotation', () => {
        const sql = 'REFRESH EVERY {refresh_interval:UInt32} SECOND';
        const params = { refresh_interval: 60 };
        const result = substituteQueryParams(sql, params);
        expect(result).toBe('REFRESH EVERY 60 SECOND');
    });

    test('should substitute identifier parameters', () => {
        const sql =
            'SELECT * FROM {canonical_database:Identifier}.blocks WHERE block_num > {days_back:UInt32}';
        const params = {
            canonical_database: 'mainnet:blocks@v0.1.0',
            days_back: 30,
        };
        const result = substituteQueryParams(sql, params);
        expect(result).toBe(
            'SELECT * FROM `mainnet:blocks@v0.1.0`.blocks WHERE block_num > 30',
        );
    });

    test('should substitute multiple occurrences of the same parameter', () => {
        const sql =
            'SELECT * FROM {db:Identifier}.table1 JOIN {db:Identifier}.table2';
        const params = { db: 'mydb' };
        const result = substituteQueryParams(sql, params);
        expect(result).toBe('SELECT * FROM mydb.table1 JOIN mydb.table2');
    });

    test('should handle string parameters', () => {
        const sql = 'SELECT * FROM {source_database:Identifier}.blocks';
        const params = { source_database: 'bsc:evm-dex@v0.2.6' };
        const result = substituteQueryParams(sql, params);
        expect(result).toBe('SELECT * FROM `bsc:evm-dex@v0.2.6`.blocks');
    });

    test('should escape backticks in identifiers', () => {
        const sql = 'SELECT * FROM {db:Identifier}.blocks';
        const params = { db: 'my`db' };
        const result = substituteQueryParams(sql, params);
        expect(result).toBe('SELECT * FROM `my``db`.blocks');
    });

    test('should leave SQL unchanged when no params provided', () => {
        const sql = 'SELECT * FROM blocks';
        const params = {};
        const result = substituteQueryParams(sql, params);
        expect(result).toBe('SELECT * FROM blocks');
    });

    test('should leave unmatched placeholders unchanged', () => {
        const sql = 'REFRESH EVERY {refresh_interval:UInt32} SECOND';
        const params = { other_param: 100 };
        const result = substituteQueryParams(sql, params);
        expect(result).toBe('REFRESH EVERY {refresh_interval:UInt32} SECOND');
    });

    test('should handle complex forked blocks MV SQL', () => {
        const sql = `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_blocks_forked
REFRESH EVERY {refresh_interval:UInt32} SECOND
TO blocks_forked
AS
WITH
    (SELECT max(block_num) FROM {canonical_database:Identifier}.blocks) AS max_block,
    (SELECT min(block_num) FROM {canonical_database:Identifier}.blocks WHERE toDate(timestamp) >= today() - {days_back:UInt32}) AS min_block
SELECT * FROM {source_database:Identifier}.blocks`;

        const params = {
            refresh_interval: 60,
            canonical_database: 'mainnet:blocks@v0.1.0',
            source_database: 'bsc:evm-dex@v0.2.6',
            days_back: 30,
        };

        const result = substituteQueryParams(sql, params);

        expect(result).toContain('REFRESH EVERY 60 SECOND');
        expect(result).toContain('FROM `mainnet:blocks@v0.1.0`.blocks');
        expect(result).toContain('today() - 30');
        expect(result).toContain('FROM `bsc:evm-dex@v0.2.6`.blocks');
        expect(result).not.toContain('{');
        expect(result).not.toContain('}');
    });
});

describe('splitSqlStatements', () => {
    test('should split SQL statements correctly', () => {
        const testSql = `
-- This is a comment
CREATE TABLE test1 (id UInt32);

-- Another comment
CREATE TABLE test2 (
    id UInt32,
    name String
);

ALTER TABLE test1 ADD COLUMN extra String;
`;

        const statements = splitSqlStatements(testSql);
        expect(statements.length).toBe(3);
    });
});

describe('transformSqlForCluster', () => {
    test('should add ON CLUSTER clause', () => {
        const testSqlForTransform = `
CREATE TABLE IF NOT EXISTS test_table (
    id UInt32,
    name String
)
ENGINE = ReplacingMergeTree(version)
ORDER BY id;

ALTER TABLE test_table ADD COLUMN extra String;

CREATE OR REPLACE FUNCTION test_func AS (x) -> x * 2;
`;

        const transformed = transformSqlForCluster(
            testSqlForTransform,
            'my_cluster',
        );

        expect(transformed).toContain("ON CLUSTER 'my_cluster'");
    });

    test('should add ON CLUSTER to CREATE OR REPLACE FUNCTION', () => {
        const sql = 'CREATE OR REPLACE FUNCTION test_func AS (x) -> x * 2;';
        const transformed = transformSqlForCluster(sql, 'my_cluster');

        expect(transformed).toContain(
            "CREATE OR REPLACE FUNCTION test_func ON CLUSTER 'my_cluster'",
        );
    });

    test('should add ON CLUSTER to plain CREATE FUNCTION', () => {
        const sql = 'CREATE FUNCTION test_func AS (x) -> x * 2;';
        const transformed = transformSqlForCluster(sql, 'my_cluster');

        expect(transformed).toContain(
            "CREATE FUNCTION test_func ON CLUSTER 'my_cluster'",
        );
    });

    test('should add ON CLUSTER to CREATE FUNCTION IF NOT EXISTS', () => {
        const sql = 'CREATE FUNCTION IF NOT EXISTS test_func AS (x) -> x * 2;';
        const transformed = transformSqlForCluster(sql, 'my_cluster');

        expect(transformed).toContain(
            "CREATE FUNCTION IF NOT EXISTS test_func ON CLUSTER 'my_cluster'",
        );
    });

    test('should add ON CLUSTER to CREATE MATERIALIZED VIEW', () => {
        const sql =
            'CREATE MATERIALIZED VIEW mv_test TO target_table AS SELECT * FROM source;';
        const transformed = transformSqlForCluster(sql, 'my_cluster');

        expect(transformed).toContain(
            "CREATE MATERIALIZED VIEW mv_test ON CLUSTER 'my_cluster'",
        );
    });

    test('should add ON CLUSTER to CREATE MATERIALIZED VIEW IF NOT EXISTS', () => {
        const sql =
            'CREATE MATERIALIZED VIEW IF NOT EXISTS mv_test TO target_table AS SELECT * FROM source;';
        const transformed = transformSqlForCluster(sql, 'my_cluster');

        expect(transformed).toContain(
            "CREATE MATERIALIZED VIEW IF NOT EXISTS mv_test ON CLUSTER 'my_cluster'",
        );
    });

    test('should convert to ReplicatedReplacingMergeTree', () => {
        const testSqlForTransform = `
CREATE TABLE IF NOT EXISTS test_table (
    id UInt32,
    name String
)
ENGINE = ReplacingMergeTree(version)
ORDER BY id;
`;

        const transformed = transformSqlForCluster(
            testSqlForTransform,
            'my_cluster',
        );

        expect(transformed).toContain('ReplicatedReplacingMergeTree');
    });

    test('should add ZooKeeper path', () => {
        const testSqlForTransform = `
CREATE TABLE IF NOT EXISTS test_table (
    id UInt32,
    name String
)
ENGINE = ReplacingMergeTree(version)
ORDER BY id;
`;

        const transformed = transformSqlForCluster(
            testSqlForTransform,
            'my_cluster',
        );

        expect(transformed).toContain(
            '/clickhouse/tables/{shard}/{database}/{table}',
        );
    });

    test('should convert MergeTree without parentheses to ReplicatedMergeTree', () => {
        const sql = `
CREATE TABLE test_table (
    id UInt32
)
ENGINE = MergeTree
ORDER BY id;
`;
        const transformed = transformSqlForCluster(sql, 'my_cluster');

        expect(transformed).toContain('ReplicatedMergeTree');
        expect(transformed).toContain(
            '/clickhouse/tables/{shard}/{database}/{table}',
        );
        expect(transformed).toContain("'{replica}'");
        // Should not have the original MergeTree anymore
        expect(transformed).not.toMatch(/ENGINE\s*=\s*MergeTree(?!\()/i);
    });

    test('should convert MergeTree with empty parentheses to ReplicatedMergeTree', () => {
        const sql = `
CREATE TABLE test_table (
    id UInt32
)
ENGINE = MergeTree()
ORDER BY id;
`;
        const transformed = transformSqlForCluster(sql, 'my_cluster');

        expect(transformed).toContain('ReplicatedMergeTree');
        expect(transformed).toContain(
            '/clickhouse/tables/{shard}/{database}/{table}',
        );
    });

    test('should convert MergeTree with parameters to ReplicatedMergeTree', () => {
        const sql = `
CREATE TABLE test_table (
    id UInt32,
    date Date
)
ENGINE = MergeTree(date, id, 8192)
ORDER BY id;
`;
        const transformed = transformSqlForCluster(sql, 'my_cluster');

        expect(transformed).toContain('ReplicatedMergeTree');
        expect(transformed).toContain(
            '/clickhouse/tables/{shard}/{database}/{table}',
        );
        expect(transformed).toContain('date, id, 8192');
    });
});

describe('schema files', () => {
    test('should parse metadata schema', async () => {
        const metadataSql = await Bun.file(
            './sql.schemas/schema.metadata_evm.sql',
        ).text();
        const metadataStatements = splitSqlStatements(metadataSql);

        expect(metadataStatements.length).toBeGreaterThan(0);
    });

    test('should transform metadata schema for cluster', async () => {
        const metadataSql = await Bun.file(
            './sql.schemas/schema.metadata_evm.sql',
        ).text();
        const transformedMetadata = transformSqlForCluster(
            metadataSql,
            'test_cluster',
        );

        expect(transformedMetadata).toContain("ON CLUSTER 'test_cluster'");
        expect(transformedMetadata).toContain('ReplicatedReplacingMergeTree');
    });

    test('should transform all actual metadata.sql correctly', async () => {
        const metadataSql = await Bun.file(
            './sql.schemas/schema.metadata_evm.sql',
        ).text();
        const transformed = transformSqlForCluster(metadataSql, 'test_cluster');

        // Check all CREATE TABLE statements have ON CLUSTER
        const tableMatches = transformed.match(/CREATE\s+TABLE/gi);
        const tableClusterMatches = transformed.match(
            /CREATE\s+TABLE.*ON\s+CLUSTER/gi,
        );
        expect(tableMatches?.length).toBe(tableClusterMatches?.length);

        // Check ReplacingMergeTree converted to ReplicatedReplacingMergeTree
        // (metadata schema only uses ReplacingMergeTree, not plain MergeTree)
        expect(transformed).toContain('ReplicatedReplacingMergeTree');

        // Ensure no plain MergeTree left
        const plainMergeTree = transformed.match(
            /ENGINE\s*=\s*MergeTree(?=\s|$|;)/gi,
        );
        expect(plainMergeTree).toBeNull();
    });

    test('should parse hyperliquid outcomes schema and transform for cluster', async () => {
        const sql = await Bun.file(
            './sql.schemas/schema.hyperliquid_outcomes.sql',
        ).text();
        const statements = splitSqlStatements(sql);
        expect(statements.length).toBe(2);

        const transformed = transformSqlForCluster(sql, 'test_cluster');
        const tableMatches = transformed.match(/CREATE\s+TABLE/gi);
        const tableClusterMatches = transformed.match(
            /CREATE\s+TABLE.*ON\s+CLUSTER/gi,
        );
        expect(tableMatches?.length).toBe(tableClusterMatches?.length);
        expect(transformed).toContain('ReplicatedReplacingMergeTree');
        expect(transformed).toContain('state_outcome_meta');
        expect(transformed).toContain('state_question_meta');
    });
});

describe('error handling', () => {
    test('should provide helpful error for non-SQL file', async () => {
        try {
            await executeSqlSetup(['nonexistent-cluster-name'], {});
            expect(true).toBe(false); // Should not reach here
        } catch (error) {
            const err = error as Error;
            expect(err.message).toContain('File not found');
            expect(err.message).toContain('--cluster');
            expect(err.message).toContain('nonexistent-cluster-name');
        }
    });

    test('should provide simple error for SQL file not found', async () => {
        try {
            await executeSqlSetup(['nonexistent.sql'], {});
            expect(true).toBe(false); // Should not reach here
        } catch (error) {
            const err = error as Error;
            expect(err.message).toContain('File not found');
            expect(err.message).not.toContain('--cluster'); // Should not suggest cluster for .sql files
        }
    });
});

describe('showClusters', () => {
    test('should export showClusters function', async () => {
        const { showClusters } = await import('./setup');
        expect(typeof showClusters).toBe('function');
    });
});

describe('promptClusterSelection', () => {
    test('should export promptClusterSelection function', async () => {
        const { promptClusterSelection } = await import('./setup');
        expect(typeof promptClusterSelection).toBe('function');
    });
});
