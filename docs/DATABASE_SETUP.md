# Database Setup Guide

This document provides detailed instructions for setting up the ClickHouse database for the Token API Scraper.

## Overview

The Token API Scraper requires specific database tables and helper functions to store and process blockchain data. The `setup` command handles deployment of SQL schema files to your ClickHouse database.

## Prerequisites

- ClickHouse server installed and running
- Network access to ClickHouse server
- Appropriate permissions to create databases, tables, and functions

## Quick Setup

The fastest way to get started:

```bash
# Deploy EVM metadata schema files to ClickHouse
npm run cli setup metadata-evm

# Deploy Solana metadata schema files to ClickHouse
npm run cli setup metadata-solana
```

This creates all necessary:
- Helper functions
- Tables with appropriate engines
- Indexes for optimal query performance

## Schema Files

The project includes these main schema files:

### 1. schema.metadata_evm.sql

**Purpose**: Stores EVM token metadata (name, symbol, decimals)

**Contents**:
- **Tables**:
  - `metadata` - Stores token metadata from smart contracts
  - `metadata_errors` - Tracks RPC errors during metadata fetching
  - Uses `ReplacingMergeTree` engine for automatic deduplication

**Deployment**:
```bash
npm run cli setup metadata-evm
```

### 2. schema.metadata_solana.sql

**Purpose**: Stores Solana SPL token metadata (name, symbol, decimals, uri, source, token_standard) and deploys helper lookup functions for common Solana program IDs and token mints.

**Contents**:
- **Tables**:
  - `metadata` - Stores token metadata from Metaplex or Token-2022
  - `metadata_errors` - Tracks RPC errors during metadata fetching
  - `program_names()` - Maps common Solana program IDs to human-readable names
  - `token_names()` - Maps common Solana token mint addresses to human-readable names
  - Uses `ReplacingMergeTree` engine for automatic deduplication

**Deployment**:
```bash
npm run cli setup metadata-solana
```

## Deployment Options

### Single Database

Deploy to a single ClickHouse instance:

```bash
# Deploy EVM metadata schemas
npm run cli setup metadata-evm

# Deploy Solana metadata schemas
npm run cli setup metadata-solana

# Deploy custom SQL files
npm run cli setup files sql.schemas/schema.*.sql
```

### Custom Database Connection

Specify connection parameters:

```bash
npm run cli setup metadata-evm \
  --clickhouse-url http://localhost:8123 \
  --clickhouse-username default \
  --clickhouse-password secret \
  --clickhouse-database my_database
```

### ClickHouse Cluster

For clustered deployments, use the `--cluster` flag. This automatically:
- Adds `ON CLUSTER '<name>'` to CREATE TABLE and ALTER TABLE statements
- Adds `ON CLUSTER '<name>'` to CREATE FUNCTION statements
- Adds `ON CLUSTER '<name>'` to CREATE MATERIALIZED VIEW statements
- Converts `MergeTree` engines to `ReplicatedMergeTree`
- Converts `ReplacingMergeTree` to `ReplicatedReplacingMergeTree`

```bash
# Deploy to a cluster
npm run cli setup metadata-evm --cluster my_cluster

# Deploy to cluster with custom settings
npm run cli setup files sql.schemas/schema.*.sql \
  --cluster production_cluster \
  --clickhouse-url http://clickhouse-node1:8123 \
  --clickhouse-database evm_data
```

## Table Schemas

### metadata (EVM)

Stores EVM token metadata fetched from smart contracts.

```sql
CREATE TABLE IF NOT EXISTS metadata
(
    block_num UInt32,
    timestamp DateTime('UTC'),
    network String,
    contract String,
    decimals UInt8,
    name String,
    symbol String,
    created_at DateTime('UTC') DEFAULT now()
)
ENGINE = ReplacingMergeTree(block_num)
ORDER BY (network, contract)
```

### metadata (Solana)

Stores Solana token metadata fetched from Metaplex or Token-2022.

```sql
CREATE TABLE IF NOT EXISTS metadata
(
    block_num UInt32,
    timestamp DateTime('UTC'),
    network String,
    contract String,
    decimals UInt8,
    name String,
    symbol String,
    uri String,
    source LowCardinality(String),
    token_standard Nullable(Enum8('NonFungible' = 0, 'FungibleAsset' = 1, 'Fungible' = 2, 'NonFungibleEdition' = 3, 'ProgrammableNonFungible' = 4, 'ProgrammableNonFungibleEdition' = 5)),
    created_at DateTime('UTC') DEFAULT now()
)
ENGINE = ReplacingMergeTree(block_num)
ORDER BY (network, contract)
```

**Additional Columns for Solana**:
- `uri` - Token metadata URI (e.g., IPFS link)
- `source` - Metadata source ('metaplex', 'token2022', 'none')
- `token_standard` - Token standard (Metaplex TokenStandard enum, NULL for tokens without metadata)

### metadata_errors

Tracks RPC errors during metadata fetching (same for both EVM and Solana).

```sql
CREATE TABLE IF NOT EXISTS metadata_errors
(
    network String,
    contract String,
    error LowCardinality(String) DEFAULT '',
    created_at DateTime('UTC') DEFAULT now()
)
ENGINE = ReplacingMergeTree(created_at)
TTL created_at + INTERVAL 1 WEEK
ORDER BY (network, contract)
```

## Database Requirements

### ClickHouse Version

Recommended: ClickHouse 21.3 or later

Required features:
- UInt256 support
- User-defined functions
- ReplacingMergeTree engine

### Disk Space

Estimate storage requirements based on:
- Number of tokens
- Number of unique accounts
- Historical depth

Typical usage:
- Metadata: ~1 MB per 1,000 tokens

### Performance Considerations

**Indexes**: The schemas include appropriate indexes for:
- Token contract lookups
- Network filtering
- Block number range queries

## Cluster Configuration

### Replicated Tables

When using `--cluster`, tables are automatically configured for replication:

```sql
CREATE TABLE IF NOT EXISTS metadata ON CLUSTER production_cluster
(
    -- columns
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/metadata', '{replica}', block_num)
ORDER BY (network, contract)
```

### Distributed Tables

For query optimization across shards:

```sql
CREATE TABLE IF NOT EXISTS metadata_distributed ON CLUSTER production_cluster AS metadata
ENGINE = Distributed(production_cluster, default, metadata, rand())
```

## Verification

### Check Tables

```bash
# List all tables
echo "SHOW TABLES" | clickhouse-client

# Check table structure
echo "DESCRIBE TABLE metadata" | clickhouse-client

# Check row counts
echo "SELECT COUNT(*) FROM metadata" | clickhouse-client
```

### Health Check

The project includes a database health check script:

```bash
npm run check-db
```

## Migration and Updates

### Schema Updates

To update schemas:

1. Modify the SQL file
2. Re-run the setup command
3. The `IF NOT EXISTS` clauses prevent errors

```bash
npm run cli setup metadata-evm
```

### Adding Indexes

```sql
ALTER TABLE metadata
ADD INDEX idx_contract (contract) TYPE minmax GRANULARITY 1;
```

### Adding Columns

```sql
ALTER TABLE metadata
ADD COLUMN IF NOT EXISTS timestamp DateTime DEFAULT now();
```

## Troubleshooting

### Connection Refused

```bash
# Check if ClickHouse is running
curl http://localhost:8123/ping

# Check firewall
sudo ufw status

# Check ClickHouse logs
sudo tail -f /var/log/clickhouse-server/clickhouse-server.log
```

### Permission Denied

```bash
# Grant permissions
echo "GRANT ALL ON database.* TO user" | clickhouse-client
```

### Schema Already Exists

The setup command uses `IF NOT EXISTS` clauses, so it's safe to run multiple times. If you need to recreate tables:

```sql
DROP TABLE IF EXISTS metadata;
```

Then re-run:
```bash
npm run cli setup metadata-evm
```

## Best Practices

1. **Always backup** before schema changes
2. **Test in development** before production deployment
3. **Use clusters** for production workloads
4. **Monitor disk space** as data grows
5. **Create indexes** for frequently queried columns
6. **Use materialized views** for common aggregations
7. **Partition large tables** by date or block number
8. **Regular maintenance**: Run `OPTIMIZE TABLE` periodically

## Additional Resources

- [ClickHouse Documentation](https://clickhouse.com/docs)
- [MergeTree Family](https://clickhouse.com/docs/en/engines/table-engines/mergetree-family/)
- [Distributed Engine](https://clickhouse.com/docs/en/engines/table-engines/special/distributed/)
- [User-Defined Functions](https://clickhouse.com/docs/en/sql-reference/functions/user-defined-functions/)
