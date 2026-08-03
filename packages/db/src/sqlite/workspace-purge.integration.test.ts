import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  cells,
  columns,
  dataTables,
  importJobs,
  outboxEvents,
  rows,
  users,
  workspaceMembers,
  workspacePurgeHolds,
  workspacePurgeReceipts,
  workspaces,
} from './schema';
import {
  ensureSqlitePersonalWorkspace,
  previewSqliteWorkspacePurge,
  purgeSqliteWorkspace,
  SqliteWorkspacePurgeAccessError,
  SqliteWorkspacePurgeConflictError,
  SqliteWorkspacePurgeValidationError,
} from './workspaces';

const ownerId = 'purge-owner';
const adminId = 'purge-admin';
const outsiderId = 'purge-outsider';
const neighborId = 'purge-neighbor';

describe('SQLite workspace purge lifecycle', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let workspaceId: string;
  let workspaceName: string;
  let neighborWorkspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-purge-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values([
      { email: 'purge-owner@example.test', id: ownerId, name: 'Purge Owner' },
      { email: 'purge-admin@example.test', id: adminId, name: 'Purge Admin' },
      {
        email: 'purge-outsider@example.test',
        id: outsiderId,
        name: 'Purge Outsider',
      },
      {
        email: 'purge-neighbor@example.test',
        id: neighborId,
        name: 'Neighbor Owner',
      },
    ]);

    const workspace = await ensureSqlitePersonalWorkspace(handle.db, {
      id: ownerId,
      name: 'Purge Owner',
    });
    const neighbor = await ensureSqlitePersonalWorkspace(handle.db, {
      id: neighborId,
      name: 'Neighbor Owner',
    });
    workspaceId = workspace.id;
    workspaceName = workspace.name;
    neighborWorkspaceId = neighbor.id;
    await handle.db.insert(workspaceMembers).values({
      role: 'admin',
      userId: adminId,
      workspaceId,
    });
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('blocks unsafe deletion and retains only an opaque receipt after cascading data', async () => {
    await expect(
      previewSqliteWorkspacePurge(handle.db, {
        userId: adminId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWorkspacePurgeAccessError);
    await expect(
      previewSqliteWorkspacePurge(handle.db, {
        userId: outsiderId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWorkspacePurgeAccessError);

    const [table] = await handle.db
      .select({ id: dataTables.id })
      .from(dataTables)
      .where(eq(dataTables.workspaceId, workspaceId))
      .limit(1);
    const [column] = await handle.db
      .select({ id: columns.id })
      .from(columns)
      .where(eq(columns.tableId, table!.id))
      .limit(1);
    const [firstRow] = await handle.db
      .insert(rows)
      .values({ position: 'a0', tableId: table!.id, workspaceId })
      .returning({ id: rows.id });
    await handle.db.insert(cells).values({
      columnId: column!.id,
      rowId: firstRow!.id,
      searchText: 'must be erased',
      tableId: table!.id,
      valueText: 'must be erased',
      valueType: 'text',
      workspaceId,
    });
    const [activeImport] = await handle.db
      .insert(importJobs)
      .values({
        createdByUserId: ownerId,
        filename: 'purge-proof.csv',
        tableId: table!.id,
        workspaceId,
      })
      .returning({ id: importJobs.id });
    await handle.db.insert(outboxEvents).values({
      aggregateId: 'purge-aggregate',
      aggregateType: 'workspace_purge_test',
      eventType: 'cell_run_succeeded',
      payload: {},
      workspaceId,
    });

    const blocked = await previewSqliteWorkspacePurge(handle.db, {
      userId: ownerId,
      workspaceId,
    });
    expect(blocked).toMatchObject({
      blockers: [expect.objectContaining({ code: 'active_work', count: 1 })],
      canPurge: false,
      impact: {
        auditRecords: 1,
        cells: 1,
        columns: 2,
        credentials: 0,
        executionRecords: 1,
        integrations: 0,
        invitations: 0,
        members: 2,
        rows: 1,
        tables: 1,
      },
    });

    await handle.db
      .update(importJobs)
      .set({ status: 'cancelled' })
      .where(eq(importJobs.id, activeImport!.id));
    const stalePreview = await previewSqliteWorkspacePurge(handle.db, {
      userId: ownerId,
      workspaceId,
    });
    expect(stalePreview.canPurge).toBe(true);

    await handle.db.insert(rows).values({
      position: 'a1',
      tableId: table!.id,
      workspaceId,
    });
    await expect(
      purgeSqliteWorkspace(handle.db, {
        acknowledgeIrreversible: true,
        confirmationName: workspaceName,
        previewDigest: stalePreview.previewDigest,
        reason: 'test_data',
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWorkspacePurgeConflictError);

    await handle.db.insert(workspacePurgeHolds).values({
      placedBy: 'integration-test-operator',
      reason: 'Required integration test retention hold.',
      workspaceId,
    });
    const held = await previewSqliteWorkspacePurge(handle.db, {
      userId: ownerId,
      workspaceId,
    });
    expect(held.blockers).toEqual([
      expect.objectContaining({ code: 'legal_hold', count: 1 }),
    ]);
    await expect(
      purgeSqliteWorkspace(handle.db, {
        acknowledgeIrreversible: true,
        confirmationName: workspaceName,
        previewDigest: held.previewDigest,
        reason: 'test_data',
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWorkspacePurgeConflictError);

    await handle.db
      .delete(workspacePurgeHolds)
      .where(eq(workspacePurgeHolds.workspaceId, workspaceId));
    const ready = await previewSqliteWorkspacePurge(handle.db, {
      userId: ownerId,
      workspaceId,
    });
    expect(ready).toMatchObject({ canPurge: true, impact: { rows: 2 } });
    await expect(
      purgeSqliteWorkspace(handle.db, {
        acknowledgeIrreversible: true,
        confirmationName: `${workspaceName} `,
        previewDigest: ready.previewDigest,
        reason: 'test_data',
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWorkspacePurgeValidationError);

    const receipt = await purgeSqliteWorkspace(handle.db, {
      acknowledgeIrreversible: true,
      confirmationName: workspaceName,
      previewDigest: ready.previewDigest,
      reason: 'test_data',
      userId: ownerId,
      workspaceId,
    });
    expect(receipt).toMatchObject({
      actorUserId: ownerId,
      impact: expect.objectContaining({ cells: 1, rows: 2 }),
      reason: 'test_data',
      workspaceId,
    });

    expect(
      await handle.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
    ).toEqual([]);
    expect(
      await handle.db
        .select({ id: rows.id })
        .from(rows)
        .where(eq(rows.workspaceId, workspaceId))
    ).toEqual([]);
    expect(
      await handle.db
        .select({ id: outboxEvents.id })
        .from(outboxEvents)
        .where(eq(outboxEvents.workspaceId, workspaceId))
    ).toEqual([]);
    expect(
      await handle.db
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(eq(workspaces.id, neighborWorkspaceId))
    ).toHaveLength(1);

    const [storedReceipt] = await handle.db
      .select()
      .from(workspacePurgeReceipts)
      .where(eq(workspacePurgeReceipts.id, receipt.id));
    expect(storedReceipt).toBeDefined();
    expect(JSON.stringify(storedReceipt)).not.toContain(workspaceName);
  });
});
