import { afterEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { defaultSqliteDatabaseUrl, sqliteDatabaseConfigSchema } from './config';

describe('SQLite database bootstrap', () => {
  let handle: SqliteDatabaseHandle | undefined;

  afterEach(() => handle?.close());

  it('uses an explicit local file default', () => {
    expect(defaultSqliteDatabaseUrl()).toBe('file:./data/byok-grid.sqlite');
  });

  it('rejects PostgreSQL URLs', () => {
    expect(() =>
      sqliteDatabaseConfigSchema.parse({
        url: 'postgresql://localhost/byok_grid',
      })
    ).toThrow(/SQLite URLs/);
  });

  it('enables connection safety invariants', async () => {
    handle = await openSqliteDatabase({ url: ':memory:' });
    const foreignKeys = await handle.client.execute('PRAGMA foreign_keys');
    const busyTimeout = await handle.client.execute('PRAGMA busy_timeout');

    expect(foreignKeys.rows[0]?.[0]).toBe(1);
    expect(busyTimeout.rows[0]?.[0]).toBe(5_000);
  });
});
