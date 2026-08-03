import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { randomInt } from 'node:crypto';
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
const sqliteDatabaseClients = new WeakMap<
  SqliteDatabase,
  Readonly<{ client: Client; local: boolean }>
>();
export const SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const SQLITE_WRITE_ACQUISITION_MAX_ATTEMPTS = 3;
const SQLITE_WRITE_RETRY_BASE_DELAY_MS = 25;
const SQLITE_WRITE_RETRY_MAX_DELAY_MS = 100;
let sqliteWriteAcquisitionRetries = 0;
let sqliteWriteAcquisitionExhaustions = 0;

export interface SqliteDatabaseHandle {
  client: Client;
  db: SqliteDatabase;
  close(): void;
}

export interface SqliteWriteContentionSnapshot {
  acquisitionExhaustions: number;
  acquisitionRetries: number;
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

  const db = drizzle({ client, schema });
  sqliteDatabaseClients.set(db, {
    client,
    local: config.url === ':memory:' || config.url.startsWith('file:'),
  });
  return {
    client,
    close: () => client.close(),
    db,
  };
}

/** Returns monotonic, process-local counters without database or tenant data. */
export function sqliteWriteContentionSnapshot(): SqliteWriteContentionSnapshot {
  return {
    acquisitionExhaustions: sqliteWriteAcquisitionExhaustions,
    acquisitionRetries: sqliteWriteAcquisitionRetries,
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
 * A separate bounded retry covers SQLITE_BUSY/SQLITE_LOCKED failures only when
 * BEGIN IMMEDIATE fails before the application callback starts. Once the
 * callback starts, retrying could repeat application work or an ambiguous
 * commit and is therefore forbidden.
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
    return await runSqliteWriteTransaction(db, transaction);
  } finally {
    release();
    if (sqliteWriteTails.get(db) === tail) {
      sqliteWriteTails.delete(db);
    }
  }
}

async function runSqliteWriteTransaction<T>(
  db: SqliteDatabase,
  transaction: (tx: SqliteTransaction) => Promise<T>
): Promise<T> {
  for (
    let attempt = 1;
    attempt <= SQLITE_WRITE_ACQUISITION_MAX_ATTEMPTS;
    attempt += 1
  ) {
    let callbackStarted = false;
    try {
      return await db.transaction(
        async (tx) => {
          callbackStarted = true;
          return transaction(tx);
        },
        { behavior: 'immediate' }
      );
    } catch (error) {
      const acquisitionConflict =
        !callbackStarted && isSqliteWriteAcquisitionConflict(error);
      if (!acquisitionConflict) {
        throw error;
      }
      if (attempt === SQLITE_WRITE_ACQUISITION_MAX_ATTEMPTS) {
        sqliteWriteAcquisitionExhaustions += 1;
        throw error;
      }
      sqliteWriteAcquisitionRetries += 1;
      await resetLocalSqliteConnection(db);
      await delay(sqliteWriteRetryDelayMs(attempt));
    }
  }
  throw new Error('SQLite write acquisition exhausted unexpectedly.');
}

async function resetLocalSqliteConnection(db: SqliteDatabase): Promise<void> {
  const entry = sqliteDatabaseClients.get(db);
  if (!entry?.local) return;
  await entry.client.reconnect();
  await entry.client.execute('PRAGMA foreign_keys = ON');
  await entry.client.execute(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  await entry.client.execute('PRAGMA synchronous = NORMAL');
}

function isSqliteWriteAcquisitionConflict(error: unknown): boolean {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0 && seen.size < 8) {
    const current = pending.shift();
    if (
      !current ||
      (typeof current !== 'object' && typeof current !== 'function')
    )
      continue;
    if (seen.has(current)) continue;
    seen.add(current);

    const value = current as {
      cause?: unknown;
      code?: unknown;
      extendedCode?: unknown;
    };
    const codes = [value.code, value.extendedCode].filter(
      (code): code is string => typeof code === 'string'
    );
    if (codes.some(sqliteLockCode)) {
      return true;
    }
    if (codes.length > 0) return false;
    if (value.cause !== undefined) pending.push(value.cause);
  }
  return false;
}

function sqliteLockCode(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    (value === 'SQLITE_BUSY' ||
      value.startsWith('SQLITE_BUSY_') ||
      value === 'SQLITE_LOCKED' ||
      value.startsWith('SQLITE_LOCKED_'))
  );
}

function sqliteWriteRetryDelayMs(attempt: number): number {
  const base = Math.min(
    SQLITE_WRITE_RETRY_MAX_DELAY_MS / 2,
    SQLITE_WRITE_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1)
  );
  return base + randomInt(0, base + 1);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
