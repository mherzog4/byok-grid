import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';

const currentMigrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../sqlite-migrations'
);

describe('SQLite N-1 upgrade compatibility', () => {
  let directory: string | undefined;
  let handle: SqliteDatabaseHandle | undefined;

  afterEach(() => {
    handle?.close();
    if (directory) rmSync(directory, { force: true, recursive: true });
  });

  it('preserves populated data and remains readable by the previous migration set', async () => {
    directory = mkdtempSync(join(tmpdir(), 'byok-grid-upgrade-'));
    const previousMigrationsFolder = createPreviousMigrationsFolder(directory);
    handle = await openSqliteDatabase({
      url: `file:${join(directory, 'upgrade.sqlite')}`,
    });

    await migrateSqliteDatabase(handle.db, previousMigrationsFolder);
    await handle.client.batch(
      [
        {
          args: ['upgrade-user', 'upgrade@example.test', 'Upgrade Owner'],
          sql: 'insert into users (id, email, name) values (?, ?, ?)',
        },
        {
          args: ['upgrade-workspace', 'Upgrade Workspace', 'upgrade-workspace'],
          sql: 'insert into workspaces (id, name, slug) values (?, ?, ?)',
        },
        {
          args: ['upgrade-workspace', 'upgrade-user', 'owner'],
          sql: 'insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?)',
        },
      ],
      'write'
    );

    const beforeUpgrade = await handle.client.execute(
      "select name from sqlite_master where type = 'table' and name = 'workflow_runs'"
    );
    expect(beforeUpgrade.rows).toHaveLength(0);

    await migrateSqliteDatabase(handle.db, currentMigrationsFolder);
    await migrateSqliteDatabase(handle.db, previousMigrationsFolder);

    const user = await handle.client.execute({
      args: ['upgrade-user'],
      sql: 'select email from users where id = ?',
    });
    const migrationCount = await handle.client.execute(
      'select count(*) from __drizzle_migrations'
    );
    const addedTable = await handle.client.execute(
      "select name from sqlite_master where type = 'table' and name = 'workflow_runs'"
    );
    const integrity = await handle.client.execute('PRAGMA quick_check');
    const foreignKeys = await handle.client.execute('PRAGMA foreign_key_check');

    expect(user.rows[0]?.[0]).toBe('upgrade@example.test');
    expect(Number(migrationCount.rows[0]?.[0])).toBe(9);
    expect(addedTable.rows).toHaveLength(1);
    expect(integrity.rows[0]?.[0]).toBe('ok');
    expect(foreignKeys.rows).toHaveLength(0);
  });
});

function createPreviousMigrationsFolder(directory: string): string {
  const destination = join(directory, 'previous-migrations');
  const metadataDirectory = join(destination, 'meta');
  mkdirSync(metadataDirectory, { recursive: true });

  const journal = JSON.parse(
    readFileSync(join(currentMigrationsFolder, 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ tag: string }>; [key: string]: unknown };
  const previousEntries = journal.entries.slice(0, -1);
  writeFileSync(
    join(metadataDirectory, '_journal.json'),
    `${JSON.stringify({ ...journal, entries: previousEntries }, null, 2)}\n`
  );

  for (const entry of previousEntries) {
    copyFileSync(
      join(currentMigrationsFolder, `${entry.tag}.sql`),
      join(destination, `${entry.tag}.sql`)
    );
  }
  return destination;
}
