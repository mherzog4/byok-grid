import { parseMasterKey } from '@byok-grid/security';
import { and, eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cancelSqliteBulkRunBatch,
  createSqliteBulkRunBatch,
  expandSqliteBulkRunBatchChunk,
  getSqliteBulkRunBatch,
  previewSqliteBulkRun,
  SqliteBulkRunConflictError,
} from './bulk-runs';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { createSqliteEncryptedCredential } from './credentials';
import { createSqliteConnectorActionColumn } from './enrichments';
import { createSqliteGridRow, writeSqliteGridCell } from './grid';
import { migrateSqliteDatabase } from './migrate';
import { bulkRunItems, cellRuns, outboxEvents, users } from './schema';
import { createSqliteWorkspaceTable } from './tables';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const userId = 'sqlite-bulk-owner';
const limits = {
  maxOutputTokens: 100_000,
  maxProviderRequests: 100,
  maxRows: 100,
};

describe('SQLite bulk connector runs', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let masterKey: ReturnType<typeof parseMasterKey>;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-bulk-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values({
      email: 'bulk-owner@example.test',
      id: userId,
      name: 'Bulk Owner',
    });
    masterKey = parseMasterKey(
      'bulk-test-v1',
      randomBytes(32).toString('base64')
    );
  });

  afterEach(() => {
    masterKey.value.fill(0);
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('freezes selection, expands cell runs, and cancels undispatched rows', async () => {
    const workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: userId,
        name: 'Bulk Owner',
      })
    ).id;
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Domain',
      firstColumnValueType: 'text',
      name: 'Prospects',
      userId,
      workspaceId,
    });
    const rows = [];
    for (const domain of ['a.example', 'b.example', 'c.example']) {
      const row = await createSqliteGridRow(handle.db, {
        tableId: table.id,
        userId,
        workspaceId,
      });
      rows.push(row);
      await writeSqliteGridCell(handle.db, {
        columnId: table.firstColumn.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId: table.id,
        userId,
        value: { type: 'text', value: domain },
        workspaceId,
      });
    }
    const credential = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'hunter',
      masterKey,
      name: 'Bulk Hunter',
      secret: { apiKey: 'bulk-secret-must-not-enter-outbox' },
      userId,
      workspaceId,
    });
    const target = await createSqliteConnectorActionColumn(handle.db, {
      actionId: 'domain_search',
      connectorId: 'hunter',
      connectorVersion: '1.0.0',
      credentialId: credential.id,
      inputBindings: {
        domain: { columnId: table.firstColumn.id, kind: 'column' },
      },
      name: 'Hunter result',
      outputValueType: 'json',
      protocolVersion: '1.1',
      tableId: table.id,
      userId,
      workspaceId,
    });
    const request = {
      columnId: target.id,
      limits,
      mode: 'pending' as const,
      rowLimit: 2,
      tableId: table.id,
      userId,
      workspaceId,
    };
    const stale = await previewSqliteBulkRun(handle.db, request);
    expect(stale).toMatchObject({
      inputReadyRows: 3,
      selectedRows: 2,
      totalRows: 3,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: table.firstColumn.id,
      expectedVersion: 1,
      rowId: rows[0]!.id,
      tableId: table.id,
      userId,
      value: { type: 'empty', value: null },
      workspaceId,
    });
    await expect(
      createSqliteBulkRunBatch(handle.db, {
        ...request,
        expectedSelectedRows: stale.selectedRows,
        expectedSelectionDigest: stale.selectionDigest,
      })
    ).rejects.toBeInstanceOf(SqliteBulkRunConflictError);

    const preview = await previewSqliteBulkRun(handle.db, request);
    expect(preview.selectionDigest).not.toBe(stale.selectionDigest);
    const batch = await createSqliteBulkRunBatch(handle.db, {
      ...request,
      expectedSelectedRows: preview.selectedRows,
      expectedSelectionDigest: preview.selectionDigest,
    });
    const frozen = await handle.db
      .select({ rowId: bulkRunItems.rowId })
      .from(bulkRunItems)
      .where(eq(bulkRunItems.batchId, batch.id))
      .orderBy(bulkRunItems.sequence);
    expect(frozen.map(({ rowId }) => rowId)).toEqual([
      rows[1]!.id,
      rows[2]!.id,
    ]);
    expect(
      await expandSqliteBulkRunBatchChunk(
        handle.db,
        { batchId: batch.id, workspaceId },
        1
      )
    ).toEqual({ processed: 1, status: 'running' });
    const cancelled = await cancelSqliteBulkRunBatch(handle.db, {
      batchId: batch.id,
      tableId: table.id,
      userId,
      workspaceId,
    });
    expect(cancelled).toMatchObject({
      queuedRowCount: 1,
      skippedRowCount: 1,
      status: 'cancelled',
    });
    expect(
      await expandSqliteBulkRunBatchChunk(handle.db, {
        batchId: batch.id,
        workspaceId,
      })
    ).toEqual({ processed: 0, status: 'cancelled' });
    expect(
      await getSqliteBulkRunBatch(handle.db, {
        batchId: batch.id,
        tableId: table.id,
        userId,
        workspaceId,
      })
    ).toMatchObject({
      items: { pending: 0, queued: 1, skipped: 1 },
      runs: { cancelled: 1 },
      status: 'cancelled',
    });
    const [run] = await handle.db
      .select()
      .from(cellRuns)
      .where(eq(cellRuns.workspaceId, workspaceId));
    expect(run?.status).toBe('cancelled');
    const events = await handle.db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.workspaceId, workspaceId),
          eq(outboxEvents.eventType, 'cell.run_requested')
        )
      );
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain('bulk-secret');
  });
});
