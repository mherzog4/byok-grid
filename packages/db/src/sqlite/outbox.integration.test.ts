import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  claimSqliteOutboxEvents,
  completeSqliteOutboxEvent,
  retrySqliteOutboxEvent,
  SqliteOutboxClaimConflictError,
} from './outbox';
import { outboxEvents, users, workspaces } from './schema';

const now = new Date('2030-01-01T12:00:00.000Z');

describe('SQLite outbox dispatch leases', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-outbox-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    const userId = randomUUID();
    workspaceId = randomUUID();
    await handle.db.insert(users).values({
      email: `${userId}@example.test`,
      id: userId,
      name: 'Outbox Owner',
    });
    await handle.db.insert(workspaces).values({
      id: workspaceId,
      name: 'Outbox Workspace',
      slug: `outbox-${workspaceId}`,
    });
  });

  afterEach(() => {
    handle.close();
    removeDatabase(databasePath);
  });

  it('partitions simultaneous claims without duplication', async () => {
    const eventIds = await insertEvents(handle, workspaceId, 3);
    const [left, right] = await Promise.all([
      claimSqliteOutboxEvents(handle.db, {
        claimId: 'worker-left',
        limit: 2,
        now,
      }),
      claimSqliteOutboxEvents(handle.db, {
        claimId: 'worker-right',
        limit: 2,
        now,
      }),
    ]);

    const claimedIds = [...left, ...right].map((event) => event.id);
    expect(claimedIds).toHaveLength(3);
    expect(new Set(claimedIds)).toEqual(new Set(eventIds));
    expect([...left, ...right].map((event) => event.attempt)).toEqual([
      1, 1, 1,
    ]);
    expect(
      await claimSqliteOutboxEvents(handle.db, {
        claimId: 'worker-third',
        now,
      })
    ).toEqual([]);
  });

  it('fences completion and honors retry scheduling', async () => {
    const [eventId] = await insertEvents(handle, workspaceId, 1);
    const [claimed] = await claimSqliteOutboxEvents(handle.db, {
      claimId: 'worker-a',
      now,
    });
    expect(claimed?.id).toBe(eventId);

    await expect(
      completeSqliteOutboxEvent(handle.db, {
        claimId: 'stale-worker',
        eventId: eventId!,
        publishedAt: now,
      })
    ).rejects.toBeInstanceOf(SqliteOutboxClaimConflictError);

    const retryAt = new Date(now.getTime() + 60_000);
    await retrySqliteOutboxEvent(handle.db, {
      claimId: 'worker-a',
      errorMessage: `Hatchet\nfailed\t${'x'.repeat(600)}`,
      eventId: eventId!,
      retryAt,
    });
    expect(
      await claimSqliteOutboxEvents(handle.db, {
        claimId: 'worker-b',
        now: new Date(retryAt.getTime() - 1),
      })
    ).toEqual([]);

    const [retried] = await claimSqliteOutboxEvents(handle.db, {
      claimId: 'worker-b',
      now: retryAt,
    });
    expect(retried).toMatchObject({ attempt: 2, id: eventId });
    await completeSqliteOutboxEvent(handle.db, {
      claimId: 'worker-b',
      eventId: eventId!,
      publishedAt: retryAt,
    });

    const [stored] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, eventId!));
    expect(stored).toMatchObject({
      dispatchAttempts: 2,
      dispatchClaimId: null,
      dispatchLastError: null,
      publishedAt: retryAt,
    });
  });

  it('leases only the event types owned by a specialized dispatcher', async () => {
    const [legacyId] = await insertEvents(handle, workspaceId, 1);
    const workflowId = randomUUID();
    await handle.db.insert(outboxEvents).values({
      aggregateId: workflowId,
      aggregateType: 'workflow_run',
      createdAt: new Date(now.getTime() + 1),
      eventType: 'workflow.run_requested',
      payload: { runId: workflowId, workspaceId },
      workspaceId,
    });

    const claimed = await claimSqliteOutboxEvents(handle.db, {
      claimId: 'workflow-dispatcher',
      eventTypes: ['workflow.run_requested'],
      now: new Date(now.getTime() + 2),
    });
    expect(claimed).toEqual([
      expect.objectContaining({
        aggregateId: workflowId,
        eventType: 'workflow.run_requested',
      }),
    ]);
    const [legacy] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.id, legacyId!));
    expect(legacy).toMatchObject({
      dispatchAttempts: 0,
      dispatchClaimId: null,
    });
  });

  it('recovers an abandoned lease but ignores non-dispatch events', async () => {
    const [eventId] = await insertEvents(handle, workspaceId, 1);
    await handle.db.insert(outboxEvents).values({
      aggregateId: randomUUID(),
      aggregateType: 'import_job',
      createdAt: new Date(now.getTime() - 10_000),
      eventType: 'table.csv_import_succeeded',
      payload: {},
      workspaceId,
    });
    await claimSqliteOutboxEvents(handle.db, {
      claimId: 'crashed-worker',
      leaseSeconds: 30,
      now,
    });

    expect(
      await claimSqliteOutboxEvents(handle.db, {
        claimId: 'early-worker',
        leaseSeconds: 30,
        now: new Date(now.getTime() + 29_999),
      })
    ).toEqual([]);
    const [recovered] = await claimSqliteOutboxEvents(handle.db, {
      claimId: 'recovery-worker',
      leaseSeconds: 30,
      now: new Date(now.getTime() + 30_001),
    });
    expect(recovered).toMatchObject({ attempt: 2, id: eventId });
  });
});

describe('SQLite dispatch-lease migration', () => {
  it('preserves a pre-lease outbox event while initializing claim defaults', async () => {
    const databasePath = join(
      tmpdir(),
      `byok-grid-outbox-upgrade-${randomUUID()}.sqlite`
    );
    const handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    try {
      await handle.client.executeMultiple(`
        create table workspaces (
          id text primary key not null,
          name text not null,
          slug text not null,
          created_at integer not null,
          updated_at integer not null
        );
        create table outbox_events (
          id text primary key not null,
          workspace_id text not null references workspaces(id) on delete cascade,
          aggregate_type text not null,
          aggregate_id text not null,
          event_type text not null,
          payload text not null,
          created_at integer not null,
          published_at integer,
          analytics_claim_id text,
          analytics_claimed_at integer,
          analytics_projected_at integer,
          analytics_attempts integer default 0 not null,
          analytics_next_attempt_at integer,
          analytics_last_error text
        );
        create index outbox_unpublished_idx on outbox_events(published_at, created_at);
        create index outbox_analytics_projection_idx on outbox_events(analytics_projected_at, analytics_next_attempt_at, created_at);
        create index outbox_workspace_created_idx on outbox_events(workspace_id, created_at);
        insert into workspaces values ('workspace-old', 'Old', 'old', 1, 1);
        insert into outbox_events (
          id, workspace_id, aggregate_type, aggregate_id, event_type, payload,
          created_at, analytics_attempts
        ) values (
          'event-old', 'workspace-old', 'import_job', 'aggregate-old',
          'table.csv_import_requested', '{"importJobId":"old"}', 1, 3
        );
      `);
      const migration = readFileSync(
        new URL(
          '../../sqlite-migrations/0006_sleepy_shiver_man.sql',
          import.meta.url
        ),
        'utf8'
      ).replaceAll('--> statement-breakpoint', '');
      await handle.client.executeMultiple(migration);

      const result = await handle.client.execute(
        "select id, payload, dispatch_claim_id, dispatch_claimed_at, dispatch_attempts, analytics_attempts from outbox_events where id = 'event-old'"
      );
      expect(result.rows[0]).toMatchObject({
        analytics_attempts: 3,
        dispatch_attempts: 0,
        dispatch_claim_id: null,
        dispatch_claimed_at: null,
        id: 'event-old',
        payload: '{"importJobId":"old"}',
      });
    } finally {
      handle.close();
      removeDatabase(databasePath);
    }
  });
});

async function insertEvents(
  handle: SqliteDatabaseHandle,
  workspaceId: string,
  count: number
): Promise<string[]> {
  const ids = Array.from({ length: count }, () => randomUUID());
  await handle.db.insert(outboxEvents).values(
    ids.map((id, index) => ({
      aggregateId: randomUUID(),
      aggregateType: 'import_job',
      createdAt: new Date(now.getTime() + index),
      eventType: 'table.csv_import_requested',
      id,
      payload: { importJobId: randomUUID() },
      workspaceId,
    }))
  );
  return ids;
}

function removeDatabase(databasePath: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    rmSync(`${databasePath}${suffix}`, { force: true });
  }
}
