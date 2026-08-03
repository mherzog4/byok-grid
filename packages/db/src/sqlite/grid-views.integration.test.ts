import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import {
  createSqliteGridRow,
  getSqliteGridSnapshot,
  listSqliteWorkspaceTables,
  writeSqliteGridCell,
} from './grid';
import {
  SqliteGridAccessError,
  SqliteGridValidationError,
} from './grid-errors';
import {
  createSqliteSavedGridView,
  deleteSqliteSavedGridView,
  listSqliteSavedGridViews,
  updateSqliteSavedGridView,
} from './grid-views';
import { migrateSqliteDatabase } from './migrate';
import { users } from './schema';
import { createSqliteInputColumn } from './tables';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const ownerId = 'view-owner';
const outsiderId = 'view-outsider';

describe('SQLite saved typed grid views', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let tableId: string;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-views-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values([
      { email: 'view-owner@example.test', id: ownerId, name: 'View Owner' },
      {
        email: 'view-outsider@example.test',
        id: outsiderId,
        name: 'View Outsider',
      },
    ]);
    workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: ownerId,
        name: 'View Owner',
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

  it('filters, sorts, paginates, validates, and remains tenant scoped', async () => {
    const initial = await getSqliteGridSnapshot(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    const company = initial.columns.find(
      (column) => column.name === 'Company'
    )!;
    const score = await createSqliteInputColumn(handle.db, {
      name: 'Score',
      tableId,
      userId: ownerId,
      valueType: 'number',
      workspaceId,
    });
    const verified = await createSqliteInputColumn(handle.db, {
      name: 'Verified',
      tableId,
      userId: ownerId,
      valueType: 'boolean',
      workspaceId,
    });
    const seenAt = await createSqliteInputColumn(handle.db, {
      name: 'Seen at',
      tableId,
      userId: ownerId,
      valueType: 'timestamp',
      workspaceId,
    });

    for (const [name, numericScore, isVerified, seenAtValue] of [
      ['Alpha', 50, true, '2026-01-03T00:00:00.000Z'],
      ['Beta', 40, false, '2026-01-04T00:00:00.000Z'],
      ['Gamma', 30, true, '2026-01-02T00:00:00.000Z'],
      ['Delta', 5, false, '2026-01-05T00:00:00.000Z'],
      ['Echo', 100, true, '2026-01-06T00:00:00.000Z'],
    ] as const) {
      const row = await createSqliteGridRow(handle.db, {
        tableId,
        userId: ownerId,
        workspaceId,
      });
      for (const [columnId, value] of [
        [company.id, { type: 'text', value: name }],
        [score.id, { type: 'number', value: numericScore }],
        [verified.id, { type: 'boolean', value: isVerified }],
        [seenAt.id, { type: 'timestamp', value: seenAtValue }],
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
    }
    const emptyScoreRow = await createSqliteGridRow(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: company.id,
      expectedVersion: 0,
      rowId: emptyScoreRow.id,
      tableId,
      userId: ownerId,
      value: { type: 'text', value: 'Aardvark' },
      workspaceId,
    });

    const view = await createSqliteSavedGridView(handle.db, {
      filters: [
        { columnId: company.id, operator: 'text_contains', value: 'a' },
        { columnId: score.id, operator: 'number_gt', value: 10 },
      ],
      name: '  Qualified accounts  ',
      sort: { columnId: score.id, direction: 'desc' },
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(view.name).toBe('Qualified accounts');
    expect(
      await listSqliteSavedGridViews(handle.db, {
        tableId,
        userId: ownerId,
        workspaceId,
      })
    ).toEqual([
      expect.objectContaining({ id: view.id, name: 'Qualified accounts' }),
    ]);

    const first = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      { limit: 2, viewId: view.id }
    );
    const second = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      { cursor: first.pageInfo.nextCursor, limit: 2, viewId: view.id }
    );
    expect(first.activeView).toEqual({ id: view.id, name: view.name });
    expect(first.rows.map((row) => row.cells[score.id]?.value)).toEqual([
      { type: 'number', value: 50 },
      { type: 'number', value: 40 },
    ]);
    expect(second.rows.map((row) => row.cells[score.id]?.value)).toEqual([
      { type: 'number', value: 30 },
    ]);
    expect(second.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    await expect(
      getSqliteGridSnapshot(
        handle.db,
        { tableId, userId: ownerId, workspaceId },
        { cursor: first.pageInfo.nextCursor, limit: 2 }
      )
    ).rejects.toBeInstanceOf(SqliteGridValidationError);

    const typedView = await createSqliteSavedGridView(handle.db, {
      filters: [
        { columnId: verified.id, operator: 'boolean_is', value: true },
        {
          columnId: seenAt.id,
          operator: 'timestamp_after',
          value: '2026-01-02T00:00:00.000Z',
        },
      ],
      name: 'Recently verified',
      sort: { columnId: seenAt.id, direction: 'desc' },
      tableId,
      userId: ownerId,
      workspaceId,
    });
    const typedFirst = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      { limit: 1, viewId: typedView.id }
    );
    const typedSecond = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      {
        cursor: typedFirst.pageInfo.nextCursor,
        limit: 1,
        viewId: typedView.id,
      }
    );
    expect(
      [...typedFirst.rows, ...typedSecond.rows].map(
        (row) =>
          (row.cells[company.id]?.value as { type: 'text'; value: string })
            .value
      )
    ).toEqual(['Echo', 'Alpha']);

    const nested = await createSqliteSavedGridView(handle.db, {
      filterTree: {
        children: [
          {
            children: [
              { columnId: verified.id, operator: 'boolean_is', value: true },
              { columnId: score.id, operator: 'number_gt', value: 80 },
            ],
            combinator: 'and',
          },
          {
            children: [
              { columnId: verified.id, operator: 'boolean_is', value: false },
              { columnId: score.id, operator: 'number_lt', value: 10 },
            ],
            combinator: 'and',
          },
        ],
        combinator: 'or',
      },
      name: 'High confidence or low score',
      sort: { columnId: company.id, direction: 'asc' },
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(
      (
        await getSqliteGridSnapshot(
          handle.db,
          { tableId, userId: ownerId, workspaceId },
          { viewId: nested.id }
        )
      ).rows.map(
        (row) =>
          (row.cells[company.id]?.value as { type: 'text'; value: string })
            .value
      )
    ).toEqual(['Delta', 'Echo']);

    const emptyLast = await createSqliteSavedGridView(handle.db, {
      filters: [{ columnId: company.id, operator: 'is_not_empty' }],
      name: 'Empty scores last',
      sort: { columnId: score.id, direction: 'asc' },
      tableId,
      userId: ownerId,
      workspaceId,
    });
    const nonEmpty = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      { limit: 5, viewId: emptyLast.id }
    );
    const emptyPage = await getSqliteGridSnapshot(
      handle.db,
      { tableId, userId: ownerId, workspaceId },
      {
        cursor: nonEmpty.pageInfo.nextCursor,
        limit: 5,
        viewId: emptyLast.id,
      }
    );
    expect(nonEmpty.rows.map((row) => row.cells[score.id]?.value)).toEqual([
      { type: 'number', value: 5 },
      { type: 'number', value: 30 },
      { type: 'number', value: 40 },
      { type: 'number', value: 50 },
      { type: 'number', value: 100 },
    ]);
    expect(emptyPage.rows.map((row) => row.id)).toEqual([emptyScoreRow.id]);

    await expect(
      createSqliteSavedGridView(handle.db, {
        filters: [{ columnId: company.id, operator: 'number_gt', value: 1 }],
        name: 'Wrong type',
        sort: null,
        tableId,
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridValidationError);
    await expect(
      listSqliteSavedGridViews(handle.db, {
        tableId,
        userId: outsiderId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridAccessError);

    const updated = await updateSqliteSavedGridView(handle.db, {
      filters: [{ columnId: company.id, operator: 'is_not_empty' }],
      name: 'Named accounts',
      sort: { columnId: company.id, direction: 'asc' },
      tableId,
      userId: ownerId,
      viewId: view.id,
      workspaceId,
    });
    expect(updated.name).toBe('Named accounts');
    expect(
      await deleteSqliteSavedGridView(handle.db, {
        tableId,
        userId: ownerId,
        viewId: updated.id,
        workspaceId,
      })
    ).toEqual({ id: updated.id });
  });
});
