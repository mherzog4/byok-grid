import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import {
  SqliteGridAccessError,
  SqliteGridConflictError,
  SqliteGridValidationError,
} from './grid-errors';
import { migrateSqliteDatabase } from './migrate';
import { columns, dataTables, users } from './schema';
import {
  createSqliteInputColumn,
  createSqliteWorkspaceTable,
  renameSqliteWorkspaceTable,
} from './tables';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const ownerId = 'table-owner';
const outsiderId = 'table-outsider';

describe('SQLite table management', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-tables-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values([
      { email: 'table-owner@example.test', id: ownerId, name: 'Table Owner' },
      {
        email: 'table-outsider@example.test',
        id: outsiderId,
        name: 'Table Outsider',
      },
    ]);
    workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: ownerId,
        name: 'Table Owner',
      })
    ).id;
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('creates normalized tables and columns with case-insensitive namespaces', async () => {
    const created = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: '  Company  ',
      firstColumnValueType: 'text',
      name: '  Lead Lists  ',
      userId: ownerId,
      workspaceId,
    });
    expect(created).toMatchObject({
      firstColumn: { kind: 'input', name: 'Company', valueType: 'text' },
      name: 'Lead Lists',
    });

    const concurrent = await Promise.allSettled([
      createSqliteWorkspaceTable(handle.db, {
        firstColumnName: 'Name',
        firstColumnValueType: 'text',
        name: 'Prospects',
        userId: ownerId,
        workspaceId,
      }),
      createSqliteWorkspaceTable(handle.db, {
        firstColumnName: 'Name',
        firstColumnValueType: 'text',
        name: 'PROSPECTS',
        userId: ownerId,
        workspaceId,
      }),
    ]);
    expect(
      concurrent.filter((result) => result.status === 'fulfilled')
    ).toHaveLength(1);
    expect(
      concurrent.filter((result) => result.status === 'rejected')
    ).toHaveLength(1);
    expect(
      concurrent.find((result) => result.status === 'rejected')
    ).toMatchObject({ reason: expect.any(SqliteGridConflictError) });

    const domain = await createSqliteInputColumn(handle.db, {
      name: '  Domain  ',
      tableId: created.id,
      userId: ownerId,
      valueType: 'text',
      workspaceId,
    });
    expect(domain).toMatchObject({
      kind: 'input',
      name: 'Domain',
      valueType: 'text',
    });
    await expect(
      createSqliteInputColumn(handle.db, {
        name: 'DOMAIN',
        tableId: created.id,
        userId: ownerId,
        valueType: 'text',
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridConflictError);

    await expect(
      renameSqliteWorkspaceTable(handle.db, {
        name: 'Companies',
        tableId: created.id,
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridConflictError);
  });

  it('does not reveal foreign or archived tables', async () => {
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Name',
      firstColumnValueType: 'text',
      name: 'Private leads',
      userId: ownerId,
      workspaceId,
    });
    await expect(
      renameSqliteWorkspaceTable(handle.db, {
        name: 'Stolen',
        tableId: table.id,
        userId: outsiderId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridAccessError);

    await handle.db
      .update(dataTables)
      .set({ archivedAt: new Date() })
      .where(eq(dataTables.id, table.id));
    await expect(
      createSqliteInputColumn(handle.db, {
        name: 'Email',
        tableId: table.id,
        userId: ownerId,
        valueType: 'text',
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridAccessError);
  });

  it('enforces hard workspace table and per-table column limits', async () => {
    const [starter] = await handle.db
      .select({ id: dataTables.id })
      .from(dataTables)
      .where(eq(dataTables.workspaceId, workspaceId))
      .limit(1);
    await handle.db.insert(dataTables).values(
      Array.from({ length: 99 }, (_, index) => ({
        name: `Limit table ${index}`,
        workspaceId,
      }))
    );
    await expect(
      createSqliteWorkspaceTable(handle.db, {
        firstColumnName: 'Name',
        firstColumnValueType: 'text',
        name: 'One too many',
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridValidationError);

    await handle.db.insert(columns).values(
      Array.from({ length: 254 }, (_, index) => ({
        kind: 'input' as const,
        name: `Limit column ${index}`,
        position: `limit-${index.toString().padStart(3, '0')}`,
        tableId: starter!.id,
        valueType: 'text' as const,
        workspaceId,
      }))
    );
    await expect(
      createSqliteInputColumn(handle.db, {
        name: 'One too many',
        tableId: starter!.id,
        userId: ownerId,
        valueType: 'text',
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteGridValidationError);
  });
});
