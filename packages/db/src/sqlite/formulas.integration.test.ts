import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import {
  createSqliteFormulaColumn,
  SqliteFormulaAccessError,
  SqliteFormulaConflictError,
  SqliteFormulaValidationError,
} from './formulas';
import {
  createSqliteGridRow,
  getSqliteGridSnapshot,
  listSqliteWorkspaceTables,
  writeSqliteGridCell,
} from './grid';
import { migrateSqliteDatabase } from './migrate';
import { users } from './schema';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const ownerId = 'formula-owner';
const outsiderId = 'formula-outsider';

describe('SQLite formula columns', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let tableId: string;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-formulas-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values([
      {
        email: 'formula-owner@example.test',
        id: ownerId,
        name: 'Formula Owner',
      },
      {
        email: 'formula-outsider@example.test',
        id: outsiderId,
        name: 'Formula Outsider',
      },
    ]);
    workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: ownerId,
        name: 'Formula Owner',
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

  it('backfills rows and atomically recomputes a dependency chain', async () => {
    const initial = await getSqliteGridSnapshot(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    const company = initial.columns.find(
      (column) => column.name === 'Company'
    )!;
    const domain = initial.columns.find((column) => column.name === 'Domain')!;
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
      value: { type: 'text', value: 'Acme' },
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: domain.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId,
      userId: ownerId,
      value: { type: 'text', value: 'ACME.EXAMPLE' },
      workspaceId,
    });

    const label = await createSqliteFormulaColumn(handle.db, {
      name: 'Company label',
      source: 'CONCAT([Company], " · ", [Domain])',
      tableId,
      userId: ownerId,
      workspaceId,
    });
    const normalized = await createSqliteFormulaColumn(handle.db, {
      expression: {
        args: [{ columnId: label.id, type: 'column' }],
        function: 'lower',
        type: 'call',
      },
      name: 'Normalized label',
      tableId,
      userId: ownerId,
      workspaceId,
    });

    let snapshot = await getSqliteGridSnapshot(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(snapshot.rows[0]?.cells[label.id]?.value).toEqual({
      type: 'text',
      value: 'Acme · ACME.EXAMPLE',
    });
    expect(snapshot.rows[0]?.cells[normalized.id]?.value).toEqual({
      type: 'text',
      value: 'acme · acme.example',
    });

    await writeSqliteGridCell(handle.db, {
      columnId: domain.id,
      expectedVersion: snapshot.rows[0]!.cells[domain.id]!.version,
      rowId: row.id,
      tableId,
      userId: ownerId,
      value: { type: 'text', value: 'NEW.EXAMPLE' },
      workspaceId,
    });
    snapshot = await getSqliteGridSnapshot(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(snapshot.rows[0]?.cells[label.id]?.value).toEqual({
      type: 'text',
      value: 'Acme · NEW.EXAMPLE',
    });
    expect(snapshot.rows[0]?.cells[normalized.id]?.value).toEqual({
      type: 'text',
      value: 'acme · new.example',
    });

    await expect(
      createSqliteFormulaColumn(handle.db, {
        expression: { columnId: company.id, type: 'column' },
        name: 'Company label',
        tableId,
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteFormulaConflictError);
    await expect(
      createSqliteFormulaColumn(handle.db, {
        name: 'Invalid source',
        source: 'LOWER([Missing])',
        tableId,
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteFormulaValidationError);
    await expect(
      createSqliteFormulaColumn(handle.db, {
        expression: { columnId: company.id, type: 'column' },
        name: 'Stolen formula',
        tableId,
        userId: outsiderId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteFormulaAccessError);
  });
});
