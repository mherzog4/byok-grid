import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { getSqliteGridSnapshot } from './grid';
import { migrateSqliteDatabase } from './migrate';
import { outboxEvents, sourceRecords, users } from './schema';
import {
  applySqliteSourceRunBatch,
  createSqliteHttpJsonSource,
  listSqliteSources,
  markSqliteSourceRunRunning,
  queueSqliteManualSourceRun,
  SqliteSourceConflictError,
} from './sources';
import { createSqliteWorkspaceTable } from './tables';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const userId = 'sqlite-source-owner';

describe('SQLite source ingestion', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let tableId: string;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-source-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values({
      email: 'source-owner@example.test',
      id: userId,
      name: 'Source Owner',
    });
    workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: userId,
        name: 'Source Owner',
      })
    ).id;
    tableId = (
      await createSqliteWorkspaceTable(handle.db, {
        firstColumnName: 'Company',
        firstColumnValueType: 'text',
        name: 'Imported companies',
        userId,
        workspaceId,
      })
    ).id;
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('checkpoints runs and preserves row identity through archive and restore', async () => {
    const source = await createSqliteHttpJsonSource(handle.db, {
      credentialId: null,
      maxRecords: 20,
      missingRecordMode: 'archive',
      name: 'Company API',
      pagination: { mode: 'none' },
      recordKeyField: 'id',
      recordPath: '',
      schedule: 'manual',
      tableId,
      url: 'https://api.example.com/companies',
      userId,
      workspaceId,
    });
    const first = await queueSqliteManualSourceRun(handle.db, {
      sourceId: source.id,
      tableId,
      userId,
      workspaceId,
    });
    expect(
      await markSqliteSourceRunRunning(handle.db, {
        sourceId: source.id,
        sourceRunId: first.id,
        workspaceId,
      })
    ).toBe('ready');
    const applied = await applySqliteSourceRunBatch(handle.db, {
      batch: {
        fields: ['id', 'name'],
        records: [
          { key: 'acme', values: { id: 'acme', name: 'Acme' } },
          { key: 'globex', values: { id: 'globex', name: 'Globex' } },
        ],
      },
      sourceId: source.id,
      sourceRunId: first.id,
      tableId,
      workspaceId,
    });
    expect(applied).toMatchObject({ createdRowCount: 2, status: 'succeeded' });
    const [globexBefore] = await handle.db
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.sourceId, source.id),
          eq(sourceRecords.recordKey, 'globex')
        )
      );

    const second = await queueSqliteManualSourceRun(handle.db, {
      sourceId: source.id,
      tableId,
      userId,
      workspaceId,
    });
    await markSqliteSourceRunRunning(handle.db, {
      sourceId: source.id,
      sourceRunId: second.id,
      workspaceId,
    });
    const archived = await applySqliteSourceRunBatch(handle.db, {
      batch: {
        fields: ['id', 'name'],
        records: [{ key: 'acme', values: { id: 'acme', name: 'Acme Inc.' } }],
      },
      sourceId: source.id,
      sourceRunId: second.id,
      tableId,
      workspaceId,
    });
    expect(archived).toMatchObject({
      archivedRowCount: 1,
      status: 'succeeded',
      updatedRowCount: 1,
    });

    const third = await queueSqliteManualSourceRun(handle.db, {
      sourceId: source.id,
      tableId,
      userId,
      workspaceId,
    });
    await markSqliteSourceRunRunning(handle.db, {
      sourceId: source.id,
      sourceRunId: third.id,
      workspaceId,
    });
    const restored = await applySqliteSourceRunBatch(handle.db, {
      batch: {
        fields: ['id', 'name'],
        records: [
          { key: 'acme', values: { id: 'acme', name: 'Acme Inc.' } },
          { key: 'globex', values: { id: 'globex', name: 'Globex LLC' } },
        ],
      },
      sourceId: source.id,
      sourceRunId: third.id,
      tableId,
      workspaceId,
    });
    expect(restored).toMatchObject({
      restoredRowCount: 1,
      status: 'succeeded',
    });
    const [globexAfter] = await handle.db
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.sourceId, source.id),
          eq(sourceRecords.recordKey, 'globex')
        )
      );
    expect(globexAfter?.rowId).toBe(globexBefore?.rowId);
    expect(globexAfter?.archivedAt).toBeNull();

    const search = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId, workspaceId },
      { searchQuery: 'Globex LLC' }
    );
    expect(search.rows.map(({ id }) => id)).toEqual([globexBefore?.rowId]);
    expect(
      await listSqliteSources(handle.db, { tableId, userId, workspaceId })
    ).toMatchObject([{ id: source.id, lastRun: { id: third.id } }]);
  });

  it('queues one durable outbox event and rejects overlapping manual runs', async () => {
    const source = await createSqliteHttpJsonSource(handle.db, {
      credentialId: null,
      maxRecords: 5,
      name: 'Queue test',
      pagination: { mode: 'none' },
      recordKeyField: 'id',
      recordPath: '',
      schedule: 'manual',
      tableId,
      url: 'https://api.example.com/queue',
      userId,
      workspaceId,
    });
    const run = await queueSqliteManualSourceRun(handle.db, {
      sourceId: source.id,
      tableId,
      userId,
      workspaceId,
    });
    await expect(
      queueSqliteManualSourceRun(handle.db, {
        sourceId: source.id,
        tableId,
        userId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteSourceConflictError);
    const events = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, run.id));
    expect(events).toMatchObject([
      { eventType: 'table.source_run_requested', workspaceId },
    ]);
  });
});
