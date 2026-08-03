import { LibsqlError } from '@libsql/client';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  openSqliteDatabase,
  SQLITE_BUSY_TIMEOUT_MS,
  SQLITE_WRITE_ACQUISITION_MAX_ATTEMPTS,
  type SqliteDatabase,
  type SqliteDatabaseHandle,
  type SqliteTransaction,
  sqliteWriteContentionSnapshot,
  withSqliteWriteTransaction,
} from './client';
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
    expect(busyTimeout.rows[0]?.[0]).toBe(SQLITE_BUSY_TIMEOUT_MS);
  });

  it('retries only machine-coded lock failures that occur before the callback starts', async () => {
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('driver wrapper', {
          cause: new LibsqlError('database is busy', 'SQLITE_BUSY'),
        })
      )
      .mockImplementationOnce(
        async (callback: (tx: SqliteTransaction) => Promise<string>) =>
          callback({} as SqliteTransaction)
      );
    const callback = vi.fn(async () => 'committed');

    await expect(
      withSqliteWriteTransaction(
        { transaction } as unknown as SqliteDatabase,
        callback
      )
    ).resolves.toBe('committed');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not retry a lock error after application work starts', async () => {
    const transaction = vi.fn(
      async (callback: (tx: SqliteTransaction) => Promise<unknown>) =>
        callback({} as SqliteTransaction)
    );
    const callback = vi.fn(async () => {
      throw new LibsqlError('database is locked', 'SQLITE_LOCKED');
    });

    await expect(
      withSqliteWriteTransaction(
        { transaction } as unknown as SqliteDatabase,
        callback
      )
    ).rejects.toThrow('SQLITE_LOCKED');
    expect(transaction).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not retry an unknown error before application work starts', async () => {
    const failure = new LibsqlError(
      'authorization failed',
      'SQLITE_AUTH',
      undefined,
      undefined,
      new LibsqlError('nested lock', 'SQLITE_BUSY')
    );
    const transaction = vi.fn().mockRejectedValue(failure);
    const callback = vi.fn(async () => 'unreachable');

    await expect(
      withSqliteWriteTransaction(
        { transaction } as unknown as SqliteDatabase,
        callback
      )
    ).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledOnce();
    expect(callback).not.toHaveBeenCalled();
  });

  it('bounds acquisition retries and preserves the original error', async () => {
    const failure = new LibsqlError('database is busy', 'SQLITE_BUSY_TIMEOUT');
    const transaction = vi.fn().mockRejectedValue(failure);
    const callback = vi.fn(async () => 'unreachable');
    const before = sqliteWriteContentionSnapshot();

    await expect(
      withSqliteWriteTransaction(
        { transaction } as unknown as SqliteDatabase,
        callback
      )
    ).rejects.toBe(failure);
    expect(transaction).toHaveBeenCalledTimes(
      SQLITE_WRITE_ACQUISITION_MAX_ATTEMPTS
    );
    expect(callback).not.toHaveBeenCalled();
    expect(sqliteWriteContentionSnapshot()).toEqual({
      acquisitionExhaustions: before.acquisitionExhaustions + 1,
      acquisitionRetries:
        before.acquisitionRetries + SQLITE_WRITE_ACQUISITION_MAX_ATTEMPTS - 1,
    });
  });

  it('recovers from real cross-process SQLite lock acquisition contention', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-contention-'));
    const databasePath = join(directory, 'contention.sqlite');
    const parentHandle = await openSqliteDatabase({
      url: `file:${databasePath}`,
    });
    let holder: ChildProcessWithoutNullStreams | undefined;
    try {
      await parentHandle.client.execute(
        'create table contention_probe (id integer primary key, value text not null)'
      );
      holder = spawn(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          SQLITE_LOCK_HOLDER_SOURCE,
          databasePath,
          String(SQLITE_BUSY_TIMEOUT_MS + 500),
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      await waitForOutput(holder, 'BYOK_GRID_SQLITE_LOCK_ACQUIRED');
      const before = sqliteWriteContentionSnapshot();
      let retriedConnectionPragmas: unknown;

      await withSqliteWriteTransaction(parentHandle.db, async (tx) => {
        const foreignKeys = await tx.run('PRAGMA foreign_keys');
        const busyTimeout = await tx.run('PRAGMA busy_timeout');
        const synchronous = await tx.run('PRAGMA synchronous');
        retriedConnectionPragmas = [
          foreignKeys.rows[0]?.[0],
          busyTimeout.rows[0]?.[0],
          synchronous.rows[0]?.[0],
        ];
        await tx.run(
          "insert into contention_probe (id, value) values (2, 'parent')"
        );
      });

      const [exitCode] = await once(holder, 'exit');
      expect(exitCode).toBe(0);
      const result = await parentHandle.client.execute(
        'select count(*) from contention_probe'
      );
      expect(result.rows[0]?.[0]).toBe(2);
      expect(retriedConnectionPragmas).toEqual([1, SQLITE_BUSY_TIMEOUT_MS, 1]);
      expect(
        sqliteWriteContentionSnapshot().acquisitionRetries
      ).toBeGreaterThan(before.acquisitionRetries);
    } finally {
      if (holder?.exitCode === null) {
        holder.kill('SIGKILL');
        await once(holder, 'exit');
      }
      parentHandle.close();
      rmSync(directory, { force: true, recursive: true });
    }
  }, 15_000);
});

const SQLITE_LOCK_HOLDER_SOURCE = `
import { createClient } from '@libsql/client';
const [databasePath, holdMillisecondsText] = process.argv.slice(-2);
const client = createClient({ timeout: 5000, url: \`file:\${databasePath}\` });
const transaction = await client.transaction('write');
await transaction.execute(
  "insert into contention_probe (id, value) values (1, 'child')"
);
process.stdout.write('BYOK_GRID_SQLITE_LOCK_ACQUIRED\\n');
await new Promise((resolve) =>
  setTimeout(resolve, Number(holdMillisecondsText))
);
await transaction.commit();
client.close();
`;

async function waitForOutput(
  child: ChildProcessWithoutNullStreams,
  marker: string
): Promise<void> {
  child.stdout.setEncoding('utf8');
  let output = '';
  await new Promise<void>((resolve, reject) => {
    const receive = (chunk: string) => {
      output += chunk;
      if (output.includes(marker)) {
        child.stdout.off('data', receive);
        resolve();
      }
    };
    child.stdout.on('data', receive);
    child.once('error', reject);
    child.once('exit', (code) => {
      if (!output.includes(marker)) {
        reject(
          new Error(`SQLite lock holder exited before readiness (${code}).`)
        );
      }
    });
  });
}
