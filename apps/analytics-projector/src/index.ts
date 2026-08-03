import { openSqliteDatabase } from '@byok-grid/db';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ClickHouseProjectionClient } from './clickhouse';
import { loadAnalyticsProjectorConfig } from './config';
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
const controller = new AbortController();

process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());

try {
  await clickhouse.ensureSchema();
  while (!controller.signal.aborted) {
    try {
      const erased = await eraseWorkspaceAnalyticsBatch({
        clickhouse,
        config,
        db: database.db,
      });
      const projected = await projectAnalyticsBatch({
        clickhouse,
        config,
        db: database.db,
      });
      if (erased + projected === 0) {
        await delay(
          config.ANALYTICS_PROJECTION_POLL_SECONDS * 1_000,
          undefined,
          { signal: controller.signal }
        );
      }
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error('Analytics projection cycle failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      await delay(config.ANALYTICS_PROJECTION_POLL_SECONDS * 1_000, undefined, {
        signal: controller.signal,
      }).catch(() => undefined);
    }
  }
} finally {
  database.close();
}
