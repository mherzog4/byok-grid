import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import {
  createSqliteGridRow,
  getSqliteGridSnapshot,
  listSqliteWorkspaceTables,
  writeSqliteGridCell,
} from './grid';
import { SqliteGridAccessError } from './grid-errors';
import { migrateSqliteDatabase } from './migrate';
import {
  archiveSqliteWorkspaceColumn,
  archiveSqliteWorkspaceTable,
  convertSqliteWorkspaceColumnType,
  listSqliteArchivedTableColumns,
  listSqliteArchivedWorkspaceTables,
  previewSqliteColumnArchive,
  previewSqliteColumnTypeConversion,
  previewSqliteTableArchive,
  restoreSqliteWorkspaceColumn,
  restoreSqliteWorkspaceTable,
} from './schema-lifecycle';
import { schemaLifecycleEvents, users } from './schema';
import { createSqliteWorkspaceTable } from './tables';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const ownerId = 'lifecycle-owner';
const outsiderId = 'lifecycle-outsider';

describe('SQLite schema lifecycle', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let tableId: string;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-lifecycle-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values([
      {
        email: 'lifecycle-owner@example.test',
        id: ownerId,
        name: 'Lifecycle Owner',
      },
      {
        email: 'lifecycle-outsider@example.test',
        id: outsiderId,
        name: 'Lifecycle Outsider',
      },
    ]);
    workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: ownerId,
        name: 'Lifecycle Owner',
      })
    ).id;
    tableId = (
      await listSqliteWorkspaceTables(handle.db, {
        userId: ownerId,
        workspaceId,
      })
    )[0]!.id;
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('archives recoverably and converts cells behind a stable preview digest', async () => {
    const disposable = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Name',
      firstColumnValueType: 'text',
      name: 'Disposable',
      userId: ownerId,
      workspaceId,
    });
    const tablePreview = await previewSqliteTableArchive(handle.db, {
      tableId: disposable.id,
      userId: ownerId,
      workspaceId,
    });
    expect(tablePreview).toMatchObject({ canArchive: true });
    await archiveSqliteWorkspaceTable(handle.db, {
      confirmationName: 'Disposable',
      tableId: disposable.id,
      userId: ownerId,
      workspaceId,
    });
    expect(
      await listSqliteArchivedWorkspaceTables(handle.db, {
        userId: ownerId,
        workspaceId,
      })
    ).toHaveLength(1);
    await restoreSqliteWorkspaceTable(handle.db, {
      tableId: disposable.id,
      userId: ownerId,
      workspaceId,
    });

    let snapshot = await getSqliteGridSnapshot(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    const company = snapshot.columns.find(
      (column) => column.name === 'Company'
    )!;
    const domain = snapshot.columns.find((column) => column.name === 'Domain')!;
    const columnPreview = await previewSqliteColumnArchive(handle.db, {
      columnId: domain.id,
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(columnPreview.canArchive).toBe(true);
    await archiveSqliteWorkspaceColumn(handle.db, {
      columnId: domain.id,
      confirmationName: 'Domain',
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(
      await listSqliteArchivedTableColumns(handle.db, {
        tableId,
        userId: ownerId,
        workspaceId,
      })
    ).toHaveLength(1);
    await restoreSqliteWorkspaceColumn(handle.db, {
      columnId: domain.id,
      tableId,
      userId: ownerId,
      workspaceId,
    });

    const row = await createSqliteGridRow(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: company.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId,
      userId: ownerId,
      value: { type: 'text', value: '42.5' },
      workspaceId,
    });
    const conversionPreview = await previewSqliteColumnTypeConversion(
      handle.db,
      {
        columnId: company.id,
        tableId,
        targetType: 'number',
        userId: ownerId,
        workspaceId,
      }
    );
    expect(conversionPreview).toMatchObject({
      canConvert: true,
      impact: { convertibleCells: 1, failedCells: 0, totalCells: 1 },
    });
    await convertSqliteWorkspaceColumnType(handle.db, {
      columnId: company.id,
      confirmationName: 'Company',
      previewDigest: conversionPreview.previewDigest,
      tableId,
      targetType: 'number',
      userId: ownerId,
      workspaceId,
    });
    snapshot = await getSqliteGridSnapshot(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(
      snapshot.columns.find((column) => column.id === company.id)
    ).toMatchObject({
      valueType: 'number',
    });
    expect(snapshot.rows[0]?.cells[company.id]?.value).toEqual({
      type: 'number',
      value: 42.5,
    });
    expect(
      await handle.db
        .select({ id: schemaLifecycleEvents.id })
        .from(schemaLifecycleEvents)
        .where(eq(schemaLifecycleEvents.workspaceId, workspaceId))
    ).toHaveLength(5);

    await expect(
      previewSqliteTableArchive(handle.db, {
        tableId,
        userId: outsiderId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridAccessError);
  });
});
