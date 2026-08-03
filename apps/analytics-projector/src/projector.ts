import {
  claimSqliteAnalyticsEvents,
  claimSqliteWorkspaceAnalyticsErasures,
  completeSqliteAnalyticsEvents,
  completeSqliteWorkspaceAnalyticsErasure,
  listSqlitePurgedAnalyticsWorkspaceIds,
  retrySqliteAnalyticsEvents,
  retrySqliteWorkspaceAnalyticsErasure,
  type SqliteDatabase,
} from '@byok-grid/db';
import {
  AnalyticsEventValidationError,
  toAnalyticsProjectionRow,
} from '@byok-grid/domain';
import type { AnalyticsProjectorConfig } from './config';
import {
  ClickHouseProjectionClient,
  ClickHouseProjectionError,
} from './clickhouse';

export interface ProjectorRuntime {
  now(): Date;
  randomId(): string;
}

export async function projectAnalyticsBatch(input: {
  clickhouse: ClickHouseProjectionClient;
  config: AnalyticsProjectorConfig;
  db: SqliteDatabase;
  runtime?: ProjectorRuntime;
}): Promise<number> {
  const runtime = input.runtime ?? {
    now: () => new Date(),
    randomId: () => crypto.randomUUID(),
  };
  const claimId = runtime.randomId();
  const claimed = await claimSqliteAnalyticsEvents(input.db, {
    claimId,
    leaseSeconds: input.config.ANALYTICS_PROJECTION_LEASE_SECONDS,
    limit: input.config.ANALYTICS_PROJECTION_BATCH_SIZE,
    now: runtime.now(),
  });
  if (claimed.length === 0) return 0;

  const purgedWorkspaceIds = await listSqlitePurgedAnalyticsWorkspaceIds(
    input.db,
    claimed.map((event) => event.workspaceId)
  );
  const eligible = claimed.filter(
    (event) => !purgedWorkspaceIds.has(event.workspaceId)
  );
  if (eligible.length === 0) return 0;

  const projectedAt = runtime.now();
  const valid = [];
  for (const event of eligible) {
    try {
      valid.push({
        event,
        row: toAnalyticsProjectionRow(event, projectedAt),
      });
    } catch (error) {
      await retrySqliteAnalyticsEvents(input.db, {
        claimId,
        errorMessage: safeProjectionError(error),
        eventIds: [event.id],
        retryAt: retryTime(projectedAt, event.attempt),
      });
    }
  }
  if (valid.length === 0) return 0;

  try {
    await input.clickhouse.insert(valid.map(({ row }) => row));
    await completeSqliteAnalyticsEvents(input.db, {
      claimId,
      eventIds: valid.map(({ event }) => event.id),
      projectedAt,
    });
    return valid.length;
  } catch (error) {
    const latestAttempt = Math.max(...valid.map(({ event }) => event.attempt));
    await retrySqliteAnalyticsEvents(input.db, {
      claimId,
      errorMessage: safeProjectionError(error),
      eventIds: valid.map(({ event }) => event.id),
      retryAt: retryTime(projectedAt, latestAttempt),
    });
    return 0;
  }
}

export async function eraseWorkspaceAnalyticsBatch(input: {
  clickhouse: ClickHouseProjectionClient;
  config: AnalyticsProjectorConfig;
  db: SqliteDatabase;
  runtime?: ProjectorRuntime;
}): Promise<number> {
  const runtime = input.runtime ?? {
    now: () => new Date(),
    randomId: () => crypto.randomUUID(),
  };
  const claimId = runtime.randomId();
  const claimed = await claimSqliteWorkspaceAnalyticsErasures(input.db, {
    claimId,
    leaseSeconds: input.config.ANALYTICS_PROJECTION_LEASE_SECONDS,
    limit: input.config.ANALYTICS_PROJECTION_BATCH_SIZE,
    now: runtime.now(),
  });
  let erased = 0;
  for (const receipt of claimed) {
    const attemptedAt = runtime.now();
    try {
      await input.clickhouse.eraseWorkspace(receipt.workspaceId);
      await completeSqliteWorkspaceAnalyticsErasure(input.db, {
        claimId,
        erasedAt: attemptedAt,
        receiptId: receipt.receiptId,
      });
      erased += 1;
    } catch (error) {
      await retrySqliteWorkspaceAnalyticsErasure(input.db, {
        claimId,
        errorMessage: safeProjectionError(error),
        receiptId: receipt.receiptId,
        retryAt: retryTime(attemptedAt, receipt.attempt),
      });
    }
  }
  return erased;
}

function retryTime(now: Date, attempt: number): Date {
  const delaySeconds = Math.min(2 ** Math.min(attempt, 10), 300);
  return new Date(now.getTime() + delaySeconds * 1_000);
}

function safeProjectionError(error: unknown): string {
  if (
    error instanceof AnalyticsEventValidationError ||
    error instanceof ClickHouseProjectionError
  ) {
    return error.message;
  }
  return 'The analytics projection failed unexpectedly.';
}
