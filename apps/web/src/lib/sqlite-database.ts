import { defaultSqliteDatabaseUrl, openSqliteDatabase } from '@byok-grid/db';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const globalDatabase = globalThis as unknown as {
  byokGridSqliteDatabase?: ReturnType<typeof openSqliteDatabase>;
};

const sqliteUrl = process.env.SQLITE_DATABASE_URL ?? defaultSqliteDatabaseUrl();
if (sqliteUrl.startsWith('file:')) {
  const path = sqliteUrl.slice('file:'.length);
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

const databasePromise =
  globalDatabase.byokGridSqliteDatabase ??
  openSqliteDatabase({
    ...(process.env.SQLITE_AUTH_TOKEN
      ? { authToken: process.env.SQLITE_AUTH_TOKEN }
      : {}),
    url: sqliteUrl,
  });

if (process.env.NODE_ENV !== 'production') {
  globalDatabase.byokGridSqliteDatabase = databasePromise;
}

export const sqliteDatabase = await databasePromise;

export const sqliteDb = sqliteDatabase.db;
