import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import {
  createSqliteGridRow,
  getSqliteGridRow,
  getSqliteGridSnapshot,
  listSqliteWorkspaceTables,
  writeSqliteGridCell,
} from './grid';
import {
  SqliteGridAccessError,
  SqliteGridConflictError,
  SqliteGridValidationError,
} from './grid-errors';
import { migrateSqliteDatabase } from './migrate';
import { users } from './schema';
import { createSqliteInputColumn } from './tables';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const ownerId = 'grid-owner';
const outsiderId = 'grid-outsider';

describe('SQLite editable grid', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let tableId: string;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-grid-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values([
      { email: 'grid-owner@example.test', id: ownerId, name: 'Grid Owner' },
      {
        email: 'grid-outsider@example.test',
        id: outsiderId,
        name: 'Grid Outsider',
      },
    ]);
    workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: ownerId,
        name: 'Grid Owner',
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

  it('persists typed sparse cells and rejects stale or cross-tenant edits', async () => {
    const empty = await getSqliteGridSnapshot(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(empty.rows).toEqual([]);
    expect(empty.columns).toHaveLength(2);

    const numberColumn = await createSqliteInputColumn(handle.db, {
      name: 'Employees',
      tableId,
      userId: ownerId,
      valueType: 'number',
      workspaceId,
    });
    const booleanColumn = await createSqliteInputColumn(handle.db, {
      name: 'Qualified',
      tableId,
      userId: ownerId,
      valueType: 'boolean',
      workspaceId,
    });
    const timestampColumn = await createSqliteInputColumn(handle.db, {
      name: 'Founded',
      tableId,
      userId: ownerId,
      valueType: 'timestamp',
      workspaceId,
    });
    const jsonColumn = await createSqliteInputColumn(handle.db, {
      name: 'Metadata',
      tableId,
      userId: ownerId,
      valueType: 'json',
      workspaceId,
    });
    const row = await createSqliteGridRow(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    const textColumn = empty.columns[0]!;

    const firstWrite = await writeSqliteGridCell(handle.db, {
      columnId: textColumn.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId,
      userId: ownerId,
      value: { type: 'text', value: 'Acme' },
      workspaceId,
    });
    expect(firstWrite).toMatchObject({
      value: { type: 'text', value: 'Acme' },
      version: 1,
    });
    await expect(
      writeSqliteGridCell(handle.db, {
        columnId: textColumn.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId,
        userId: ownerId,
        value: { type: 'text', value: 'Stale overwrite' },
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridConflictError);
    await writeSqliteGridCell(handle.db, {
      columnId: textColumn.id,
      expectedVersion: 1,
      rowId: row.id,
      tableId,
      userId: ownerId,
      value: { type: 'text', value: 'Acme Labs' },
      workspaceId,
    });

    for (const [columnId, value] of [
      [numberColumn.id, { type: 'number', value: 42 }],
      [booleanColumn.id, { type: 'boolean', value: true }],
      [
        timestampColumn.id,
        { type: 'timestamp', value: '2029-03-04T05:06:07.000Z' },
      ],
      [jsonColumn.id, { type: 'json', value: { tier: 'enterprise' } }],
    ] as const) {
      await writeSqliteGridCell(handle.db, {
        columnId,
        expectedVersion: 0,
        rowId: row.id,
        tableId,
        userId: ownerId,
        value,
        workspaceId,
      });
    }

    await expect(
      writeSqliteGridCell(handle.db, {
        columnId: numberColumn.id,
        expectedVersion: 1,
        rowId: row.id,
        tableId,
        userId: ownerId,
        value: { type: 'text', value: 'forty-two' },
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridValidationError);
    await expect(
      getSqliteGridSnapshot(handle.db, {
        tableId,
        userId: outsiderId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridAccessError);

    const saved = await getSqliteGridRow(handle.db, {
      rowId: row.id,
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(saved.version).toBe(7);
    expect(saved.cells[textColumn.id]?.value).toEqual({
      type: 'text',
      value: 'Acme Labs',
    });
    expect(saved.cells[numberColumn.id]?.value).toEqual({
      type: 'number',
      value: 42,
    });
    expect(saved.cells[booleanColumn.id]?.value).toEqual({
      type: 'boolean',
      value: true,
    });
    expect(saved.cells[timestampColumn.id]?.value).toEqual({
      type: 'timestamp',
      value: '2029-03-04T05:06:07.000Z',
    });
    expect(saved.cells[jsonColumn.id]?.value).toEqual({
      type: 'json',
      value: { tier: 'enterprise' },
    });
  });

  it('uses literal trigram search and binds cursors to normalized queries', async () => {
    const column = (
      await getSqliteGridSnapshot(handle.db, {
        tableId,
        userId: ownerId,
        workspaceId,
      })
    ).columns[0]!;
    const fixtures = [
      'Acme 100%_Corp',
      'Acme Research',
      'Boston Dynamics',
      'Nothing relevant',
    ];
    const written: Array<{ cellVersion: number; rowId: string }> = [];
    for (const value of fixtures) {
      const row = await createSqliteGridRow(handle.db, {
        tableId,
        userId: ownerId,
        workspaceId,
      });
      const cell = await writeSqliteGridCell(handle.db, {
        columnId: column.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId,
        userId: ownerId,
        value: { type: 'text', value },
        workspaceId,
      });
      written.push({ cellVersion: cell.version, rowId: row.id });
    }

    const firstPage = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      { limit: 1, searchQuery: '  ＡＣＭＥ  ' }
    );
    expect(firstPage).toMatchObject({
      pageInfo: { hasMore: true },
      searchQuery: 'ACME',
    });
    expect(firstPage.rows).toHaveLength(1);
    const secondPage = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      {
        cursor: firstPage.pageInfo.nextCursor,
        limit: 1,
        searchQuery: 'ACME',
      }
    );
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.rows[0]!.id).not.toBe(firstPage.rows[0]!.id);
    await expect(
      getSqliteGridSnapshot(
        handle.db,
        { tableId, userId: ownerId, workspaceId },
        {
          cursor: firstPage.pageInfo.nextCursor,
          limit: 1,
          searchQuery: 'Boston',
        }
      )
    ).rejects.toBeInstanceOf(SqliteGridValidationError);

    const literal = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      { searchQuery: '100%_' }
    );
    expect(literal.rows).toHaveLength(1);

    const acmeRow = written[0]!;
    await writeSqliteGridCell(handle.db, {
      columnId: column.id,
      expectedVersion: acmeRow.cellVersion,
      rowId: acmeRow.rowId,
      tableId,
      userId: ownerId,
      value: { type: 'text', value: 'Seattle Software' },
      workspaceId,
    });
    const oldTerm = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      { searchQuery: '100%_' }
    );
    const newTerm = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      { searchQuery: 'Seattle' }
    );
    expect(oldTerm.rows).toHaveLength(0);
    expect(newTerm.rows.map((row) => row.id)).toEqual([acmeRow.rowId]);
  });
});
