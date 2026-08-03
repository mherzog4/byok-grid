import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  ensureSqlitePersonalWorkspace,
  listSqliteUserWorkspaces,
} from './workspaces';

describe('SQLite workspaces', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `byok-grid-workspaces-${randomUUID()}.sqlite`
    );
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.client.execute({
      args: ['user-a', 'a@example.test', 'Ada'],
      sql: 'insert into users (id, email, name) values (?, ?, ?)',
    });
    await handle.client.execute({
      args: ['user-b', 'b@example.test', 'Bea'],
      sql: 'insert into users (id, email, name) values (?, ?, ?)',
    });
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('creates one idempotent personal workspace with a starter table', async () => {
    const first = await ensureSqlitePersonalWorkspace(handle.db, {
      id: 'user-a',
      name: 'Ada',
    });
    const second = await ensureSqlitePersonalWorkspace(handle.db, {
      id: 'user-a',
      name: 'Ada',
    });

    expect(second).toEqual(first);
    expect(first).toMatchObject({
      name: "Ada's workspace",
      role: 'owner',
      slug: 'personal-user-a',
    });
    const starter = await handle.client.execute({
      args: [first.id],
      sql: 'select data_tables.name, columns.name from data_tables join columns on columns.table_id = data_tables.id where data_tables.workspace_id = ? order by columns.position',
    });
    expect(starter.rows.map((row) => [row[0], row[1]])).toEqual([
      ['Companies', 'Company'],
      ['Companies', 'Domain'],
    ]);
  });

  it('lists only workspaces where the user is a member', async () => {
    const workspaceA = await ensureSqlitePersonalWorkspace(handle.db, {
      id: 'user-a',
      name: 'Ada',
    });
    await ensureSqlitePersonalWorkspace(handle.db, {
      id: 'user-b',
      name: 'Bea',
    });

    expect(await listSqliteUserWorkspaces(handle.db, 'user-a')).toEqual([
      workspaceA,
    ]);
  });
});
