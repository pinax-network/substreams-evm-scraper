#!/usr/bin/env bun
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { client } from './lib/clickhouse';
import { DEFAULT_CONFIG } from './lib/config';
import { createLogger } from './lib/logger';
import {
    observeCycleDuration,
    setServiceNameLabel,
    startPrometheusServer,
    stopPrometheusServer,
} from './lib/prometheus';
import { executeSqlSetup, promptClusterSelection } from './lib/setup';

const log = createLogger('cli');

// Read version from package.json
const VERSION = JSON.parse(
    readFileSync(resolve(__dirname, 'package.json'), 'utf8'),
).version;

/**
 * Available services that can be run via the CLI
 * Each service corresponds to a TypeScript file in the services directory
 */
const SERVICES = {
    'metadata-transfers': {
        path: './services/metadata/transfers.ts',
        description:
            'Fetch and store ERC-20 token metadata (name, symbol, decimals) from `transfers`',
    },
    'metadata-swaps': {
        path: './services/metadata/swaps.ts',
        description:
            'Fetch and store ERC-20 token metadata (name, symbol, decimals) from `swaps`',
    },
    'metadata-balances': {
        path: './services/metadata/balances.ts',
        description:
            'Fetch and store ERC-20 token metadata (name, symbol, decimals) from `balances`',
    },
    polymarket: {
        path: './services/polymarket/index.ts',
        description:
            'Fetch and store Polymarket market metadata from condition_id and token0/token1',
    },
    hyperliquid: {
        path: './services/hyperliquid/index.ts',
        description:
            'Fetch Hyperliquid spot pair names + HIP-4 outcome / question metadata in one cycle (spotMeta + outcomeMeta + per-id settledOutcome recovery) into state_spot_pair_names, state_outcome_meta, and state_question_meta',
    },
    'kalshi-live': {
        path: './services/kalshi/live.ts',
        description:
            'Tip-follow Kalshi Trade API v2 (trades / markets / events / series / candlesticks) into the kalshi.* tables',
    },
    'kalshi-backfill': {
        path: './services/kalshi/backfill.ts',
        description:
            'Backfill the Kalshi cold-start state — trades (`/historical/trades`), settled markets (`/historical/markets`), and events (`/events` ungated) — into the shared kalshi.* tables; each pass resumable via its own cursor_state scope',
    },
    'metadata-solana-rpc': {
        path: './services/metadata-solana-rpc/index.ts',
        description:
            'Fetch and store Solana SPL token metadata from Metaplex or Token-2022 extensions via RPC',
    },
    'metadata-solana-extras-rpc': {
        path: './services/metadata-solana-extras-rpc/index.ts',
        description:
            'Derive LP token metadata for Solana tokens without standard metadata via RPC (uses heavier RPC calls like getProgramAccounts)',
    },
    'metadata-solana-clickhouse': {
        path: './services/metadata-solana-clickhouse/index.ts',
        description:
            'Fetch and store Solana SPL token metadata from ClickHouse tables (mints, metaplex, token-2022 metadata)',
    },
};

/**
 * Available setup actions that can be run via the CLI
 * Each setup action deploys SQL schemas or refreshable materialized views
 */
const SETUP_ACTIONS = {
    'metadata-evm': {
        files: ['./sql.schemas/schema.metadata_evm.sql'],
        description: 'Deploy EVM metadata tables (metadata, metadata_errors)',
    },
    'metadata-solana': {
        files: ['./sql.schemas/schema.metadata_solana.sql'],
        description:
            'Deploy Solana metadata tables (metadata, metadata_errors)',
    },
    polymarket: {
        files: ['./sql.schemas/schema.polymarket.sql'],
        description:
            'Deploy polymarket tables (polymarket_markets, polymarket_assets)',
    },
    hyperliquid: {
        files: [
            './sql.schemas/schema.hyperliquid.sql',
            './sql.schemas/schema.hyperliquid_outcomes.sql',
        ],
        description:
            'Deploy hyperliquid scraper-managed tables (state_spot_pair_names + HIP-4 state_outcome_meta + state_question_meta)',
    },
    kalshi: {
        files: ['./sql.schemas/schema.kalshi.sql'],
        description:
            'Deploy kalshi tables (series, events, markets, trades, candlesticks, cursor_state)',
    },
    'forked-blocks': {
        files: ['./sql.schemas/schema.blocks_forked.sql'],
        description:
            'Deploy blocks_forked table and refreshable materialized view for detecting forked blocks',
        requiresParams: true,
    },
};

// Initialize Commander program
const program = new Command();

program
    .name('token-api-scraper')
    .description(
        'CLI tool for running ERC-20 blockchain data scraping services',
    )
    .version(VERSION, '-v, --version', 'Display the current version');

/**
 * Helper function to create common options for service commands
 * These options control database connection, RPC settings, and monitoring
 */
function addCommonOptions(command: Command): Command {
    return (
        command
            // ClickHouse Database Options
            .option(
                '--clickhouse-url <url>',
                'ClickHouse database connection URL. Used for storing scraped blockchain data.',
                process.env.CLICKHOUSE_URL || DEFAULT_CONFIG.CLICKHOUSE_URL,
            )
            .option(
                '--clickhouse-username <user>',
                'Username for authenticating with the ClickHouse database.',
                process.env.CLICKHOUSE_USERNAME ||
                    DEFAULT_CONFIG.CLICKHOUSE_USERNAME,
            )
            .option(
                '--clickhouse-password <password>',
                'Password for authenticating with the ClickHouse database. Keep this secure!',
                process.env.CLICKHOUSE_PASSWORD ||
                    DEFAULT_CONFIG.CLICKHOUSE_PASSWORD,
            )
            .option(
                '--clickhouse-database <db>',
                'Name of the ClickHouse database to use for read operations and DDL.',
                process.env.CLICKHOUSE_DATABASE,
            )
            .option(
                '--clickhouse-database-insert <db>',
                'Optional: Name of the ClickHouse database to use for insert operations. Falls back to --clickhouse-database if not set.',
                process.env.CLICKHOUSE_DATABASE_INSERT,
            )
            // RPC Node Options
            .option(
                '--node-url <url>',
                'EVM RPC node URL for querying blockchain data. Can be a public node or your own.',
                process.env.NODE_URL,
            )
            .option(
                '--concurrency <number>',
                'Number of concurrent RPC requests. Higher values = faster but may hit rate limits. Range: 1-50.',
                process.env.CONCURRENCY || String(DEFAULT_CONFIG.CONCURRENCY),
            )
            // Retry Configuration Options
            .option(
                '--max-retries <number>',
                'Maximum number of retry attempts for failed RPC requests.',
                process.env.MAX_RETRIES || String(DEFAULT_CONFIG.MAX_RETRIES),
            )
            .option(
                '--base-delay-ms <number>',
                'Base delay in milliseconds for exponential backoff between retries.',
                process.env.BASE_DELAY_MS ||
                    String(DEFAULT_CONFIG.BASE_DELAY_MS),
            )
            .option(
                '--jitter-min <number>',
                'Minimum jitter multiplier for backoff delay (e.g., 0.7 = 70% of backoff).',
                process.env.JITTER_MIN || String(DEFAULT_CONFIG.JITTER_MIN),
            )
            .option(
                '--jitter-max <number>',
                'Maximum jitter multiplier for backoff delay (e.g., 1.3 = 130% of backoff).',
                process.env.JITTER_MAX || String(DEFAULT_CONFIG.JITTER_MAX),
            )
            .option(
                '--max-delay-ms <number>',
                'Maximum delay in milliseconds between retry attempts (cap on backoff).',
                process.env.MAX_DELAY_MS || String(DEFAULT_CONFIG.MAX_DELAY_MS),
            )
            .option(
                '--timeout-ms <number>',
                'Timeout in milliseconds for individual RPC requests.',
                process.env.TIMEOUT_MS || String(DEFAULT_CONFIG.TIMEOUT_MS),
            )
            // Monitoring Options
            .option(
                '--prometheus-port <port>',
                'HTTP port for the Prometheus metrics endpoint. Accessible at http://localhost:<port>/metrics',
                process.env.PROMETHEUS_PORT ||
                    String(DEFAULT_CONFIG.PROMETHEUS_PORT),
            )
            .option(
                '--prometheus-hostname <hostname>',
                'Hostname for the Prometheus server to bind to.',
                process.env.PROMETHEUS_HOSTNAME ||
                    DEFAULT_CONFIG.PROMETHEUS_HOSTNAME,
            )
            .option(
                '--no-prometheus',
                'Disable the Prometheus metrics server. Useful when running multiple instances or when metrics are not needed.',
            )
            // Logging Options
            .option(
                '--verbose',
                'Enable verbose logging output. When disabled, only errors are shown. Prometheus metrics are still computed.',
                process.env.VERBOSE === 'true',
            )
            .option(
                '--auto-restart-delay <seconds>',
                `Delay in seconds before restarting the service (default: ${DEFAULT_CONFIG.AUTO_RESTART_DELAY}).`,
                process.env.AUTO_RESTART_DELAY ||
                    String(DEFAULT_CONFIG.AUTO_RESTART_DELAY),
            )
    );
}

/**
 * Interface for CLI options passed to service commands
 */
interface ServiceOptions {
    clickhouseUrl: string;
    clickhouseUsername: string;
    clickhousePassword: string;
    clickhouseDatabase: string;
    clickhouseDatabaseInsert: string;
    nodeUrl: string;
    concurrency: string;
    maxRetries: string;
    baseDelayMs: string;
    jitterMin: string;
    jitterMax: string;
    maxDelayMs: string;
    timeoutMs: string;
    prometheusPort: string;
    prometheusHostname: string;
    prometheus: boolean;
    verbose: boolean;
    autoRestartDelay: string;
}

/**
 * Runs a service directly in the current process with continuous auto-restart
 * @param serviceName - Name of the service to run (must exist in SERVICES)
 * @param options - Commander options object containing CLI flags
 */
async function runService(serviceName: string, options: ServiceOptions) {
    const service = SERVICES[serviceName as keyof typeof SERVICES];

    if (!service) {
        log.error(`Unknown service: ${serviceName}`, {
            availableServices: Object.keys(SERVICES),
        });
        process.exit(1);
    }

    const autoRestartDelay = parseInt(
        options.autoRestartDelay || String(DEFAULT_CONFIG.AUTO_RESTART_DELAY),
        10,
    );

    // Validate autoRestartDelay
    if (Number.isNaN(autoRestartDelay) || autoRestartDelay < 1) {
        log.error('Invalid auto-restart delay', {
            value: options.autoRestartDelay,
            message: 'Must be a positive number (minimum 1 second)',
        });
        process.exit(1);
    }

    if (options.verbose) {
        log.info('Starting service', {
            service: serviceName,
            autoRestartDelay: `${autoRestartDelay}s`,
        });
    }

    const servicePath = resolve(__dirname, service.path);

    // Build environment variables from CLI options
    // CLI options override existing environment variables
    process.env.CLICKHOUSE_URL = options.clickhouseUrl;
    process.env.CLICKHOUSE_USERNAME = options.clickhouseUsername;
    process.env.CLICKHOUSE_PASSWORD = options.clickhousePassword;
    process.env.CLICKHOUSE_DATABASE = options.clickhouseDatabase;
    if (options.clickhouseDatabaseInsert !== undefined) {
        process.env.CLICKHOUSE_DATABASE_INSERT =
            options.clickhouseDatabaseInsert;
    }
    process.env.NODE_URL = options.nodeUrl;
    process.env.CONCURRENCY = options.concurrency;
    process.env.MAX_RETRIES = options.maxRetries;
    process.env.BASE_DELAY_MS = options.baseDelayMs;
    process.env.JITTER_MIN = options.jitterMin;
    process.env.JITTER_MAX = options.jitterMax;
    process.env.MAX_DELAY_MS = options.maxDelayMs;
    process.env.TIMEOUT_MS = options.timeoutMs;
    process.env.PROMETHEUS_PORT = options.prometheusPort;
    process.env.PROMETHEUS_HOSTNAME = options.prometheusHostname;
    process.env.VERBOSE = options.verbose ? 'true' : 'false';

    // Start Prometheus server once before the loop (if enabled)
    const prometheusEnabled = options.prometheus;
    if (prometheusEnabled) {
        const prometheusPort = parseInt(options.prometheusPort, 10);
        const prometheusHostname = options.prometheusHostname;
        try {
            await startPrometheusServer(prometheusPort, prometheusHostname);
        } catch (error) {
            log.warn(
                'Failed to start Prometheus server, continuing without metrics',
                { error },
            );
        }
    } else {
        log.info('Prometheus server disabled');
    }

    // Import and run the service module directly
    const serviceModule = await import(servicePath);

    // Check if the service module exports a run function
    if (typeof serviceModule.run !== 'function') {
        log.error('Service does not export a run function', {
            service: serviceName,
        });
        await stopPrometheusServer();
        process.exit(1);
    }

    // Run the service in a continuous loop
    let iteration = 0;

    // Label per-service metrics from the runner side too, so cycle-duration
    // observations from the loop below carry the right service name even
    // before the imported service module calls `initService` on its first run.
    setServiceNameLabel(serviceName);

    while (true) {
        iteration++;
        const cycleStart = performance.now();
        try {
            if (options.verbose && iteration > 1) {
                log.info(`Starting iteration ${iteration}`);
            }

            // Run the service
            await serviceModule.run();
            observeCycleDuration(
                (performance.now() - cycleStart) / 1000,
                'success',
            );

            if (options.verbose) {
                log.info('Service iteration completed', {
                    service: serviceName,
                    iteration,
                });
            }

            // Close ClickHouse connections to allow event loop to be idle
            await client.close();

            // Wait before restarting
            log.info(
                `Waiting ${autoRestartDelay} seconds before querying for new data`,
            );
            await new Promise((resolve) =>
                setTimeout(resolve, autoRestartDelay * 1000),
            );
        } catch (error) {
            observeCycleDuration(
                (performance.now() - cycleStart) / 1000,
                'error',
            );
            log.error('Service error', { error });
            // Close Prometheus server on error
            await stopPrometheusServer();
            process.exit(1);
        }
    }
}

// ============================================================================
// COMMAND: run <service>
// ============================================================================
const runCommand = program
    .command('run <service>')
    .description('Run a specific scraper service')
    .addHelpText(
        'after',
        `

Services:
  metadata-transfers          ${SERVICES['metadata-transfers'].description}
  metadata-swaps              ${SERVICES['metadata-swaps'].description}
  metadata-balances           ${SERVICES['metadata-balances'].description}
  polymarket                  ${SERVICES['polymarket'].description}
  hyperliquid                 ${SERVICES['hyperliquid'].description}
  kalshi-live                 ${SERVICES['kalshi-live'].description}
  kalshi-backfill             ${SERVICES['kalshi-backfill'].description}
  metadata-solana-rpc         ${SERVICES['metadata-solana-rpc'].description}
  metadata-solana-extras-rpc  ${SERVICES['metadata-solana-extras-rpc'].description}
  metadata-solana-clickhouse  ${SERVICES['metadata-solana-clickhouse'].description}

Examples:
  $ npm run cli run metadata-transfers
  $ npm run cli run metadata-swaps
  $ npm run cli run metadata-balances
  $ npm run cli run polymarket
  $ npm run cli run hyperliquid
  $ npm run cli run metadata-solana-rpc
  $ npm run cli run metadata-solana-extras-rpc
  $ npm run cli run metadata-solana-clickhouse

  # Auto-restart delay examples
  $ npm run cli run metadata-transfers --auto-restart-delay 30
  $ npm run cli run metadata-swaps --auto-restart-delay 60

  # Disable Prometheus metrics server
  $ npm run cli run metadata-transfers --no-prometheus
    `,
    )
    .action(async (service: string, options: any) => {
        await runService(service, options);
    });

// Add common options to the run command
addCommonOptions(runCommand);

// ============================================================================
// COMMAND: list
// ============================================================================
program
    .command('list')
    .description('List all available services')
    .action(() => {
        log.info('Available services:', {
            services: Object.entries(SERVICES).map(([name, info]) => ({
                name,
                description: info.description,
            })),
        });
    });

// ============================================================================
// COMMAND: setup (with subcommands for each table type)
// ============================================================================

/**
 * Helper function to add common ClickHouse options to a command
 */
function addClickhouseOptions(command: Command): Command {
    return command
        .option(
            '--clickhouse-url <url>',
            'ClickHouse database connection URL',
            process.env.CLICKHOUSE_URL || DEFAULT_CONFIG.CLICKHOUSE_URL,
        )
        .option(
            '--clickhouse-username <user>',
            'Username for authenticating with ClickHouse',
            process.env.CLICKHOUSE_USERNAME ||
                DEFAULT_CONFIG.CLICKHOUSE_USERNAME,
        )
        .option(
            '--clickhouse-password <password>',
            'Password for authenticating with ClickHouse',
            process.env.CLICKHOUSE_PASSWORD ||
                DEFAULT_CONFIG.CLICKHOUSE_PASSWORD,
        )
        .option(
            '--clickhouse-database <db>',
            'ClickHouse database name for reads and DDL',
            process.env.CLICKHOUSE_DATABASE,
        )
        .option(
            '--clickhouse-database-insert <db>',
            'Optional: ClickHouse database for insert operations',
            process.env.CLICKHOUSE_DATABASE_INSERT,
        )
        .option(
            '--cluster [name]',
            'ClickHouse cluster name. If provided without a name, shows available clusters to choose from.',
        );
}

/**
 * Common handler for setup commands
 */
async function handleSetupCommand(
    files: string[],
    options: any,
    queryParams?: Record<string, string | number>,
): Promise<void> {
    // Update ClickHouse client environment from CLI options
    if (options.clickhouseUrl)
        process.env.CLICKHOUSE_URL = options.clickhouseUrl;
    if (options.clickhouseUsername)
        process.env.CLICKHOUSE_USERNAME = options.clickhouseUsername;
    if (options.clickhousePassword)
        process.env.CLICKHOUSE_PASSWORD = options.clickhousePassword;
    if (options.clickhouseDatabase)
        process.env.CLICKHOUSE_DATABASE = options.clickhouseDatabase;
    if (options.clickhouseDatabaseInsert !== undefined)
        process.env.CLICKHOUSE_DATABASE_INSERT =
            options.clickhouseDatabaseInsert;

    // Handle cluster option
    let clusterName = options.cluster;

    // If --cluster flag is provided without a value (true), prompt for selection
    if (clusterName === true) {
        try {
            clusterName = await promptClusterSelection();
            log.info('Cluster selected', { cluster: clusterName });
        } catch (error) {
            const err = error as Error;
            log.error('Failed to select cluster', { error: err.message });
            process.exit(1);
        }
    }

    try {
        await executeSqlSetup(files, {
            cluster: clusterName,
            queryParams,
        });
        process.exit(0);
    } catch (error) {
        const err = error as Error;
        log.error('Setup failed', { error: err.message });
        process.exit(1);
    }
}

// Create setup command group
const setupCommand = program
    .command('setup')
    .description('Deploy SQL schemas and materialized views to ClickHouse');

// ---- setup metadata-evm ----
const setupMetadataEvm = setupCommand
    .command('metadata-evm')
    .description(SETUP_ACTIONS['metadata-evm'].description)
    .addHelpText(
        'after',
        `
This command deploys the metadata tables for storing ERC-20 token metadata.
It only needs to be run once to initialize the tables.

Tables created:
  - metadata: Stores token metadata (name, symbol, decimals)
  - metadata_errors: Tracks RPC errors during metadata fetching

Example:
  $ npm run cli setup metadata-evm
  $ npm run cli setup metadata-evm --cluster my_cluster
`,
    )
    .action(async (options: any) => {
        log.info('Setting up EVM metadata tables');
        const files = SETUP_ACTIONS['metadata-evm'].files.map((f) =>
            resolve(__dirname, f),
        );
        await handleSetupCommand(files, options);
    });
addClickhouseOptions(setupMetadataEvm);

// ---- setup metadata-solana ----
const setupMetadataSolana = setupCommand
    .command('metadata-solana')
    .description(SETUP_ACTIONS['metadata-solana'].description)
    .addHelpText(
        'after',
        `
This command deploys the metadata tables for storing Solana SPL token metadata.
It only needs to be run once to initialize the tables.

Tables created:
  - metadata: Stores token metadata (name, symbol, decimals, uri, source, standard)
  - metadata_errors: Tracks RPC errors during metadata fetching

Example:
  $ npm run cli setup metadata-solana
  $ npm run cli setup metadata-solana --cluster my_cluster
`,
    )
    .action(async (options: any) => {
        log.info('Setting up Solana metadata tables');
        const files = SETUP_ACTIONS['metadata-solana'].files.map((f) =>
            resolve(__dirname, f),
        );
        await handleSetupCommand(files, options);
    });
addClickhouseOptions(setupMetadataSolana);

// ---- setup polymarket ----
const setupPolymarket = setupCommand
    .command('polymarket')
    .description(SETUP_ACTIONS.polymarket.description)
    .addHelpText(
        'after',
        `
This command deploys the Polymarket tables for storing market metadata.
It only needs to be run once to initialize the tables.

Tables created:
  - polymarket_markets: Stores Polymarket market metadata
  - polymarket_assets: Links asset IDs to condition IDs

Example:
  $ npm run cli setup polymarket
  $ npm run cli setup polymarket --cluster my_cluster
`,
    )
    .action(async (options: any) => {
        log.info('Setting up polymarket tables');
        const files = SETUP_ACTIONS.polymarket.files.map((f) =>
            resolve(__dirname, f),
        );
        await handleSetupCommand(files, options);
    });
addClickhouseOptions(setupPolymarket);

// ---- setup hyperliquid ----
const setupHyperliquid = setupCommand
    .command('hyperliquid')
    .description(SETUP_ACTIONS.hyperliquid.description)
    .addHelpText(
        'after',
        `
This command deploys the Hyperliquid scraper-managed tables. It only
needs to be run once per database to initialize the tables.

Tables created:
  - state_spot_pair_names: Resolves \`@N\` and canonical pair coin values to BASE/QUOTE strings
  - state_outcome_meta:    HIP-4 per-outcome metadata (name, description, side specs, settlement)
  - state_question_meta:   HIP-4 multi-outcome question groupings (namedOutcomes, fallbackOutcome)

Example:
  $ npm run cli setup hyperliquid
  $ npm run cli setup hyperliquid --cluster my_cluster
`,
    )
    .action(async (options: any) => {
        log.info('Setting up hyperliquid scraper-managed tables');
        const files = SETUP_ACTIONS.hyperliquid.files.map((f) =>
            resolve(__dirname, f),
        );
        await handleSetupCommand(files, options);
    });
addClickhouseOptions(setupHyperliquid);

// ---- setup kalshi ----
const setupKalshi = setupCommand
    .command('kalshi')
    .description(SETUP_ACTIONS.kalshi.description)
    .addHelpText(
        'after',
        `
This command deploys the Kalshi prediction-market tables ingested by
\`npm run cli run kalshi-live\` (scraper-managed, no substreams).

Tables created:
  - series         Kalshi recurring contract templates
  - events         Real-world occurrences grouping one or more markets
  - markets        Binary/scalar markets, latest state per ticker
  - trades        Append-only trade fills (live + historical scrape target)
  - candlesticks   Server-aggregated 1m/60m/1440m bars
  - cursor_state   Per-scope cursor checkpoints for resumable polling

Example:
  $ npm run cli setup kalshi
  $ npm run cli setup kalshi --cluster my_cluster
`,
    )
    .action(async (options: any) => {
        log.info('Setting up kalshi tables');
        const files = SETUP_ACTIONS.kalshi.files.map((f) =>
            resolve(__dirname, f),
        );
        await handleSetupCommand(files, options);
    });
addClickhouseOptions(setupKalshi);

// ---- setup forked-blocks ----
const setupForkedBlocks = setupCommand
    .command('forked-blocks')
    .description(SETUP_ACTIONS['forked-blocks'].description)
    .requiredOption(
        '--canonical-database <db>',
        'Database containing canonical/irreversible blocks (e.g., mainnet:blocks@v0.1.0)',
        process.env.CLICKHOUSE_BLOCKS_DATABASE,
    )
    .option(
        '--days-back <days>',
        'Number of days to look back for forked blocks (default: 30, minimum: 1)',
        process.env.FORKED_BLOCKS_DAYS_BACK || '30',
    )
    .option(
        '--refresh-interval <seconds>',
        'Refresh interval in seconds for the materialized view (default: 60, minimum: 15)',
        '60',
    )
    .addHelpText(
        'after',
        `
This command deploys the blocks_forked table and a refreshable materialized view
that periodically detects forked blocks by comparing source blocks against
canonical/irreversible blocks from another database.

NOTE: This is a refreshable MV and only needs to be run once to initialize.
The MV will automatically refresh at the specified interval.

The source database (blocks to check for forks) is taken from --clickhouse-database
or the CLICKHOUSE_DATABASE environment variable, consistent with other setup commands.

Tables/Views created:
  - blocks_forked: Stores detected forked blocks
  - mv_blocks_forked: Refreshable MV that populates blocks_forked

Example:
  $ npm run cli setup forked-blocks \\
      --canonical-database mainnet:blocks@v0.1.0 \\
      --clickhouse-database mainnet:evm-transfers@v0.2.1

  # With custom refresh interval (every 5 minutes)
  $ npm run cli setup forked-blocks \\
      --canonical-database mainnet:blocks@v0.1.0 \\
      --clickhouse-database mainnet:evm-transfers@v0.2.1 \\
      --refresh-interval 300

  # With cluster support
  $ npm run cli setup forked-blocks \\
      --canonical-database mainnet:blocks@v0.1.0 \\
      --clickhouse-database mainnet:evm-transfers@v0.2.1 \\
      --cluster my_cluster

  # Using environment variables
  $ CLICKHOUSE_DATABASE=mainnet:evm-transfers@v0.2.1 npm run cli setup forked-blocks \\
      --canonical-database mainnet:blocks@v0.1.0
`,
    )
    .action(async (options: any) => {
        log.info('Setting up forked-blocks table and refreshable MV');

        const canonicalDatabase = options.canonicalDatabase;
        const sourceDatabase = options.clickhouseDatabase;
        const daysBack = parseInt(options.daysBack || '30', 10);
        const refreshInterval = parseInt(options.refreshInterval || '60', 10);

        // Validate parameters
        if (!canonicalDatabase) {
            log.error('--canonical-database is required');
            process.exit(1);
        }
        if (!sourceDatabase) {
            log.error(
                '--clickhouse-database is required (or set CLICKHOUSE_DATABASE environment variable)',
            );
            process.exit(1);
        }
        if (Number.isNaN(daysBack) || daysBack < 1) {
            log.error('Invalid --days-back', {
                value: options.daysBack,
                message: 'Must be a positive number (minimum 1 day)',
            });
            process.exit(1);
        }
        if (Number.isNaN(refreshInterval) || refreshInterval < 15) {
            log.error('Invalid --refresh-interval', {
                value: options.refreshInterval,
                message:
                    'Must be at least 15 seconds to avoid performance issues',
            });
            process.exit(1);
        }

        log.info('Forked blocks configuration', {
            canonicalDatabase,
            sourceDatabase,
            daysBack,
            refreshInterval,
        });

        const files = SETUP_ACTIONS['forked-blocks'].files.map((f) =>
            resolve(__dirname, f),
        );
        await handleSetupCommand(files, options, {
            canonical_database: canonicalDatabase,
            source_database: sourceDatabase,
            days_back: daysBack,
            refresh_interval: refreshInterval,
        });
    });
addClickhouseOptions(setupForkedBlocks);

// ---- setup files (for backward compatibility) ----
const setupFiles = setupCommand
    .command('files <files...>')
    .description('Deploy SQL schema files to ClickHouse database')
    .addHelpText(
        'after',
        `
Deploy custom SQL schema files to your ClickHouse database.
You can provide one or multiple SQL files to execute in sequence.

Cluster Support:
  Use --cluster flag to deploy schemas on a ClickHouse cluster:
  - Adds 'ON CLUSTER <name>' to CREATE TABLE and ALTER TABLE statements
  - Adds 'ON CLUSTER <name>' to CREATE FUNCTION statements
  - Adds 'ON CLUSTER <name>' to CREATE MATERIALIZED VIEW statements
  - Converts MergeTree engines to ReplicatedMergeTree
  - Converts ReplacingMergeTree to ReplicatedReplacingMergeTree

Examples:
  # Deploy single schema file
  $ npm run cli setup files sql.schemas/schema.metadata_evm.sql

  # Deploy multiple schema files
  $ npm run cli setup files sql.schemas/schema.metadata_evm.sql sql.schemas/schema.metadata_solana.sql

  # Deploy all schema files
  $ npm run cli setup files sql.schemas/schema.*.sql

  # Deploy to a cluster
  $ npm run cli setup files sql.schemas/schema.metadata_evm.sql --cluster my_cluster
`,
    )
    .action(async (files: string[], options: any) => {
        log.info('SQL Setup Command');
        const resolvedFiles = files.map((f) => resolve(process.cwd(), f));
        await handleSetupCommand(resolvedFiles, options);
    });
addClickhouseOptions(setupFiles);

// ============================================================================
// COMMAND: query (for troubleshooting single contract queries)
// ============================================================================
const queryCommand = program
    .command('query')
    .description('Query single contracts for troubleshooting');

// ---- query metadata-evm <contract> ----
queryCommand
    .command('metadata-evm <contract>')
    .description(
        'Query metadata for a single EVM contract address with verbose debug logging',
    )
    .option(
        '--node-url <url>',
        'EVM RPC node URL for querying blockchain data',
        process.env.NODE_URL,
    )
    .addHelpText(
        'after',
        `
This command queries metadata for a single EVM contract address with verbose debug logging.
It's useful for troubleshooting to understand why a particular token may not be returning metadata.

The command will:
  1. Validate the contract address format (EVM hex or TRON base58)
  2. Check if the contract has code (detect self-destructed contracts)
  3. Fetch decimals() - required for ERC-20 tokens
  4. Fetch symbol() - optional, some tokens don't implement this
  5. Fetch name() - optional, some tokens don't implement this

Examples:
  $ bun run cli.ts query metadata-evm 0xdAC17F958D2ee523a2206206994597C13D831ec7
  $ bun run cli.ts query metadata-evm TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
  $ bun run cli.ts query metadata-evm <contract> --node-url https://api.trongrid.io/jsonrpc
`,
    )
    .action(async (contract: string, options: { nodeUrl?: string }) => {
        // Set NODE_URL environment variable if provided via CLI
        if (options.nodeUrl) {
            process.env.NODE_URL = options.nodeUrl;
        }

        // Validate NODE_URL is set
        if (!process.env.NODE_URL) {
            log.error('NODE_URL environment variable is required');
            log.info(
                'Set it via environment variable or use --node-url option',
            );
            process.exit(1);
        }

        // Import and run the query service
        const { run: runQuery } = await import('./services/metadata/query.ts');
        await runQuery(contract);
    });

// ---- query metadata-solana <mint> ----
queryCommand
    .command('metadata-solana <mint>')
    .description(
        'Query metadata for a single Solana mint address with verbose debug logging',
    )
    .option(
        '--node-url <url>',
        'Solana RPC node URL for querying blockchain data',
        process.env.NODE_URL || process.env.SOLANA_NODE_URL,
    )
    .option(
        '--program-id <id>',
        'Override the detected program ID (TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA for SPL Token, TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb for Token-2022)',
    )
    .addHelpText(
        'after',
        `
This command queries metadata for a single Solana mint address with verbose debug logging.
It's useful for troubleshooting to understand why a particular token may not be returning metadata.

The command will:
  1. Validate the mint address format
  2. Fetch the mint account to determine if it's SPL Token or Token-2022
  3. Look up Metaplex Token Metadata (works for both program types)
  4. If Token-2022, also check for TOKEN_METADATA extension

Examples:
  $ bun run cli.ts query metadata-solana So11111111111111111111111111111111111111112
  $ bun run cli.ts query metadata-solana C8y5X4NfcXexq5WvauuWCSj9CfWJVNMnBnUfeoo4pump
  $ bun run cli.ts query metadata-solana <mint> --node-url https://api.mainnet-beta.solana.com
`,
    )
    .action(
        async (
            mint: string,
            options: { nodeUrl?: string; programId?: string },
        ) => {
            // Set NODE_URL environment variable if provided via CLI
            if (options.nodeUrl) {
                process.env.NODE_URL = options.nodeUrl;
            }

            // Validate NODE_URL is set
            if (!process.env.NODE_URL && !process.env.SOLANA_NODE_URL) {
                log.error(
                    'NODE_URL or SOLANA_NODE_URL environment variable is required',
                );
                log.info(
                    'Set it via environment variable or use --node-url option',
                );
                process.exit(1);
            }

            // Import and run the query service
            const { run: runQuery } = await import(
                './services/metadata-solana-rpc/query.ts'
            );
            await runQuery(mint, options.programId);
        },
    );

// ---- query metadata-solana-extras <mint> ----
queryCommand
    .command('metadata-solana-extras <mint>')
    .description(
        'Query LP metadata for a single Solana mint address with verbose debug logging',
    )
    .option(
        '--node-url <url>',
        'Solana RPC node URL for querying blockchain data',
        process.env.NODE_URL || process.env.SOLANA_NODE_URL,
    )
    .addHelpText(
        'after',
        `
This command queries LP token metadata for a single Solana mint address with verbose debug logging.
It's useful for troubleshooting to understand why a particular token may not be identified as an LP token.

The command will:
  1. Validate the mint address format
  2. Check if the mint is a Pump.fun AMM LP token
  3. Check if the mint is a Meteora DLMM LP token
  4. Check if the mint is a Raydium LP token (AMM V4 or CPMM)
  5. Derive LP metadata if the mint is identified as an LP token

Note: This command uses heavier RPC calls like getProgramAccounts for Raydium LP detection.

Examples:
  $ bun run cli.ts query metadata-solana-extras <mint>
  $ bun run cli.ts query metadata-solana-extras <mint> --node-url https://api.mainnet-beta.solana.com
`,
    )
    .action(async (mint: string, options: { nodeUrl?: string }) => {
        // Set NODE_URL environment variable if provided via CLI
        if (options.nodeUrl) {
            process.env.NODE_URL = options.nodeUrl;
        }

        // Validate NODE_URL is set
        if (!process.env.NODE_URL && !process.env.SOLANA_NODE_URL) {
            log.error(
                'NODE_URL or SOLANA_NODE_URL environment variable is required',
            );
            log.info(
                'Set it via environment variable or use --node-url option',
            );
            process.exit(1);
        }

        // Import and run the query service
        const { run: runQuery } = await import(
            './services/metadata-solana-extras-rpc/query.ts'
        );
        await runQuery(mint);
    });

// ============================================================================
// Parse CLI arguments
// ============================================================================
program.parse(process.argv);
