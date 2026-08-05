import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  ensureSqliteLocalUser,
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

  it('idempotently provisions the deterministic local owner', async () => {
    const localOwner = {
      email: 'local-owner@byok-grid.invalid',
      id: 'local-owner',
      name: 'Local owner',
    };

    await ensureSqliteLocalUser(handle.db, localOwner);
    await ensureSqliteLocalUser(handle.db, localOwner);

    const stored = await handle.client.execute({
      args: [localOwner.id],
      sql: 'select id, email, name, email_verified from users where id = ?',
    });
    expect(stored.rows).toEqual([
      {
        email: localOwner.email,
        email_verified: 1,
        id: localOwner.id,
        name: localOwner.name,
      },
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
