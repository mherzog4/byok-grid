import { openSqliteDatabase } from '@byok-grid/db';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ClickHouseProjectionClient } from './clickhouse';
import { loadAnalyticsProjectorConfig } from './config';
import { AnalyticsProjectorHealthServer } from './health-server';
import { runAnalyticsProjectorLifecycle } from './lifecycle';
import {
  eraseWorkspaceAnalyticsBatch,
  projectAnalyticsBatch,
} from './projector';

const config = loadAnalyticsProjectorConfig();
if (config.SQLITE_DATABASE_URL.startsWith('file:')) {
  mkdirSync(
    dirname(resolve(config.SQLITE_DATABASE_URL.slice('file:'.length))),
    { recursive: true }
  );
}
const database = await openSqliteDatabase({
  ...(config.SQLITE_AUTH_TOKEN ? { authToken: config.SQLITE_AUTH_TOKEN } : {}),
  mode: config.BYOK_GRID_DATABASE_MODE,
  url: config.SQLITE_DATABASE_URL,
});
const clickhouse = new ClickHouseProjectionClient(config);
const health = new AnalyticsProjectorHealthServer({
  port: config.ANALYTICS_HEALTH_PORT,
});

await runAnalyticsProjectorLifecycle({
  closeDatabase: () => database.close(),
  ensureSchema: (signal) => clickhouse.ensureSchema(signal),
  eraseBatch: (signal) =>
    eraseWorkspaceAnalyticsBatch({
      clickhouse,
      config,
      db: database.db,
      signal,
    }),
  health,
  pollMilliseconds: config.ANALYTICS_PROJECTION_POLL_SECONDS * 1_000,
  projectBatch: (signal) =>
    projectAnalyticsBatch({
      clickhouse,
      config,
      db: database.db,
      signal,
    }),
  reportFailure: (phase, error) => {
    console.error('Analytics projector operation failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
      phase,
    });
  },
  signalSource: process,
});
