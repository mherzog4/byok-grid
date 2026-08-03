import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import {
  sqliteDatabaseConfigSchema,
  type SqliteDatabaseConfig,
} from './config';
import * as schema from './schema';

export type SqliteDatabase = LibSQLDatabase<typeof schema>;
export type SqliteTransaction = Parameters<
  Parameters<SqliteDatabase['transaction']>[0]
>[0];

const sqliteWriteTails = new WeakMap<SqliteDatabase, Promise<void>>();
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;

export interface SqliteDatabaseHandle {
  client: Client;
  db: SqliteDatabase;
  close(): void;
}

/**
 * Opens the SQLite-first application store and installs connection invariants.
 * Each process must call this once for its own client; PRAGMAs are not a
 * substitute for transaction-level compare-and-swap claims in worker code.
 */
export async function openSqliteDatabase(
  input: SqliteDatabaseConfig
): Promise<SqliteDatabaseHandle> {
  const config = sqliteDatabaseConfigSchema.parse(input);
  const client = createClient({
    ...(config.authToken ? { authToken: config.authToken } : {}),
    // Unlike a PRAGMA issued after construction, this reaches every local
    // connection that @libsql/client opens internally for transactions.
    timeout: SQLITE_BUSY_TIMEOUT_MS,
    url: config.url,
  });

  await client.execute('PRAGMA foreign_keys = ON');
  await client.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  if (config.url !== ':memory:' && !config.url.startsWith('libsql://')) {
    await client.execute('PRAGMA journal_mode = WAL');
    await client.execute('PRAGMA synchronous = NORMAL');
  }
  await assertSqliteCapabilities(client);

  return {
    client,
    close: () => client.close(),
    db: drizzle({ client, schema }),
  };
}

/**
 * Serializes multi-statement writes made through one application database
 * handle. The local libSQL driver begins write transactions synchronously, so
 * allowing two of them to contend on one Node.js event loop can prevent the
 * first transaction from reaching its commit until busy_timeout expires.
 *
 * Database constraints and BEGIN IMMEDIATE remain the cross-process source of
 * correctness; this queue only prevents avoidable same-process starvation.
 */
export async function withSqliteWriteTransaction<T>(
  db: SqliteDatabase,
  transaction: (tx: SqliteTransaction) => Promise<T>
): Promise<T> {
  const previous = sqliteWriteTails.get(db) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => turn);
  sqliteWriteTails.set(db, tail);

  await previous;
  try {
    return await db.transaction(transaction, { behavior: 'immediate' });
  } finally {
    release();
    if (sqliteWriteTails.get(db) === tail) {
      sqliteWriteTails.delete(db);
    }
  }
}

async function assertSqliteCapabilities(client: Client): Promise<void> {
  const json = await client.execute('select json_valid(\'{"ok":true}\')');
  if (json.rows[0]?.[0] !== 1) {
    throw new Error('SQLite JSON functions are required.');
  }

  try {
    await client.execute(
      "create virtual table temp.byok_grid_fts5_probe using fts5(value, tokenize='trigram')"
    );
    await client.execute('drop table temp.byok_grid_fts5_probe');
  } catch (cause) {
    throw new Error('SQLite FTS5 with the trigram tokenizer is required.', {
      cause,
    });
  }
}
