import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import {
  assertSqliteMigrationsReady,
  SqliteMigrationStatusError,
} from './migration-status';
import { migrateSqliteDatabase } from './migrate';

describe('SQLite migration readiness', () => {
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    handle = await openSqliteDatabase({ url: ':memory:' });
  });

  afterEach(() => handle.close());

  it('requires the complete ordered migration prefix', async () => {
    await expect(
      assertSqliteMigrationsReady(handle.client)
    ).rejects.toBeInstanceOf(SqliteMigrationStatusError);

    await migrateSqliteDatabase(handle.db);
    await expect(assertSqliteMigrationsReady(handle.client)).resolves.toEqual({
      appliedCount: 9,
      expectedCount: 9,
    });

    await handle.client.execute(
      'delete from __drizzle_migrations where created_at = (select max(created_at) from __drizzle_migrations)'
    );
    await expect(assertSqliteMigrationsReady(handle.client)).rejects.toThrow(
      'SQLite migration 8 is missing or divergent.'
    );
  });

  it('allows a future migration suffix for rolling rollback compatibility', async () => {
    await migrateSqliteDatabase(handle.db);
    await handle.client.execute({
      args: ['future-test-hash', 9_999_999_999_999],
      sql: 'insert into __drizzle_migrations (hash, created_at) values (?, ?)',
    });

    await expect(assertSqliteMigrationsReady(handle.client)).resolves.toEqual({
      appliedCount: 10,
      expectedCount: 9,
    });
  });
});
