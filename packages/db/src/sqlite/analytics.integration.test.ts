import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claimSqliteAnalyticsEvents,
  claimSqliteWorkspaceAnalyticsErasures,
  completeSqliteAnalyticsEvents,
  completeSqliteWorkspaceAnalyticsErasure,
  listSqlitePurgedAnalyticsWorkspaceIds,
  retrySqliteAnalyticsEvents,
  retrySqliteWorkspaceAnalyticsErasure,
  SqliteAnalyticsProjectionConflictError,
} from './analytics';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  outboxEvents,
  users,
  workspacePurgeReceipts,
  workspaces,
} from './schema';

const start = new Date('2030-01-01T12:00:00.000Z');

describe('SQLite analytics projection leases', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let userId: string;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-analytics-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    userId = randomUUID();
    workspaceId = randomUUID();
    await handle.db.insert(users).values({
      email: `${userId}@example.test`,
      id: userId,
      name: 'Analytics Owner',
    });
    await handle.db.insert(workspaces).values({
      id: workspaceId,
      name: 'Analytics Workspace',
      slug: `analytics-${workspaceId}`,
    });
  });

  afterEach(() => {
    handle.close();
    removeDatabase(databasePath);
  });

  it('partitions claims, fences stale workers, and preserves dispatch state', async () => {
    const ids = await insertAnalyticsEvents(handle, workspaceId, 3);
    const dispatchRetryAt = new Date(start.getTime() + 120_000);
    await handle.db
      .update(outboxEvents)
      .set({
        dispatchAttempts: 7,
        dispatchClaimedAt: start,
        dispatchClaimId: 'hatchet-worker',
        dispatchLastError: 'Hatchet unavailable',
        dispatchNextAttemptAt: dispatchRetryAt,
      })
      .where(eq(outboxEvents.id, ids[0]!));

    const [left, right] = await Promise.all([
      claimSqliteAnalyticsEvents(handle.db, {
        claimId: 'projector-left',
        limit: 2,
        now: start,
      }),
      claimSqliteAnalyticsEvents(handle.db, {
        claimId: 'projector-right',
        limit: 2,
        now: start,
      }),
    ]);
    const claimed = [...left, ...right];
    expect(claimed).toHaveLength(3);
    expect(new Set(claimed.map((event) => event.id))).toEqual(new Set(ids));
    expect(claimed.map((event) => event.attempt)).toEqual([1, 1, 1]);

    const first = claimed.find((event) => event.id === ids[0])!;
    const firstClaimId = left.includes(first)
      ? 'projector-left'
      : 'projector-right';
    await expect(
      completeSqliteAnalyticsEvents(handle.db, {
        claimId: 'stale-projector',
        eventIds: [first.id],
        projectedAt: start,
      })
    ).rejects.toBeInstanceOf(SqliteAnalyticsProjectionConflictError);

    const retryAt = new Date(start.getTime() + 60_000);
    await retrySqliteAnalyticsEvents(handle.db, {
      claimId: firstClaimId,
      errorMessage: `ClickHouse\nfailed\t${'x'.repeat(600)}`,
      eventIds: [first.id],
      retryAt,
    });
    expect(
      await claimSqliteAnalyticsEvents(handle.db, {
        claimId: 'early-projector',
        now: new Date(retryAt.getTime() - 1),
      })
    ).toEqual([]);

    const [retried] = await claimSqliteAnalyticsEvents(handle.db, {
      claimId: 'retry-projector',
      now: retryAt,
    });
    expect(retried).toMatchObject({ attempt: 2, id: first.id });
    const [recovered] = await claimSqliteAnalyticsEvents(handle.db, {
      claimId: 'recovery-projector',
      leaseSeconds: 30,
      now: new Date(retryAt.getTime() + 30_001),
    });
    expect(recovered).toMatchObject({ attempt: 3, id: first.id });
    const projectedAt = new Date(retryAt.getTime() + 31_000);
    await completeSqliteAnalyticsEvents(handle.db, {
      claimId: 'recovery-projector',
      eventIds: [first.id],
      projectedAt,
    });

    const [stored] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, first.id));
    expect(stored).toMatchObject({
      analyticsAttempts: 3,
      analyticsClaimId: null,
      analyticsLastError: null,
      analyticsProjectedAt: projectedAt,
      dispatchAttempts: 7,
      dispatchClaimedAt: start,
      dispatchClaimId: 'hatchet-worker',
      dispatchLastError: 'Hatchet unavailable',
      dispatchNextAttemptAt: dispatchRetryAt,
    });
  });

  it('delays purge erasure, retries safely, and records completion', async () => {
    const receiptId = randomUUID();
    await handle.db.insert(workspacePurgeReceipts).values({
      actorUserId: userId,
      id: receiptId,
      impact: {
        auditRecords: 1,
        cells: 2,
        columns: 2,
        credentials: 0,
        executionRecords: 1,
        integrations: 0,
        invitations: 0,
        members: 1,
        rows: 2,
        tables: 1,
      },
      previewDigest: 'a'.repeat(64),
      purgedAt: start,
      reason: 'test_data',
      workspaceId,
    });
    expect(
      await listSqlitePurgedAnalyticsWorkspaceIds(handle.db, [
        workspaceId,
        workspaceId,
        randomUUID(),
      ])
    ).toEqual(new Set([workspaceId]));
    expect(
      await claimSqliteWorkspaceAnalyticsErasures(handle.db, {
        claimId: 'early-eraser',
        now: new Date(start.getTime() + 3_600_000 - 1),
      })
    ).toEqual([]);

    const readyAt = new Date(start.getTime() + 3_600_000);
    expect(
      await claimSqliteWorkspaceAnalyticsErasures(handle.db, {
        claimId: 'eraser-a',
        now: readyAt,
      })
    ).toEqual([{ attempt: 1, receiptId, workspaceId }]);
    await expect(
      completeSqliteWorkspaceAnalyticsErasure(handle.db, {
        claimId: 'stale-eraser',
        erasedAt: readyAt,
        receiptId,
      })
    ).rejects.toBeInstanceOf(SqliteAnalyticsProjectionConflictError);

    const retryAt = new Date(readyAt.getTime() + 60_000);
    await retrySqliteWorkspaceAnalyticsErasure(handle.db, {
      claimId: 'eraser-a',
      errorMessage: `ClickHouse\nfailed\t${'x'.repeat(600)}`,
      receiptId,
      retryAt,
    });
    expect(
      await claimSqliteWorkspaceAnalyticsErasures(handle.db, {
        claimId: 'early-retry-eraser',
        now: new Date(retryAt.getTime() - 1),
      })
    ).toEqual([]);
    expect(
      await claimSqliteWorkspaceAnalyticsErasures(handle.db, {
        claimId: 'eraser-b',
        now: retryAt,
      })
    ).toEqual([expect.objectContaining({ attempt: 2, receiptId })]);

    const erasedAt = new Date(retryAt.getTime() + 1_000);
    await completeSqliteWorkspaceAnalyticsErasure(handle.db, {
      claimId: 'eraser-b',
      erasedAt,
      receiptId,
    });
    const [stored] = await handle.db
      .select()
      .from(workspacePurgeReceipts)
      .where(eq(workspacePurgeReceipts.id, receiptId));
    expect(stored).toMatchObject({
      analyticsEraseAttempts: 2,
      analyticsEraseClaimId: null,
      analyticsEraseLastError: null,
      analyticsErasedAt: erasedAt,
    });
  });
});

async function insertAnalyticsEvents(
  handle: SqliteDatabaseHandle,
  workspaceId: string,
  count: number
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await handle.db.insert(outboxEvents).values(
    ids.map((id, index) => {
      const importJobId = randomUUID();
      return {
        aggregateId: importJobId,
        aggregateType: 'import_job',
        createdAt: new Date(start.getTime() + index),
        eventType: 'table.csv_import_succeeded',
        id,
        payload: {
          importJobId,
          importedRowCount: index + 1,
          tableId: randomUUID(),
        },
        workspaceId,
      };
    })
  );
  return ids;
}

function removeDatabase(databasePath: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}
