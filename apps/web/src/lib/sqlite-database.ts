import {
  defaultSqliteDatabaseUrl,
  openSqliteDatabase,
  sqliteDatabaseConfigSchema,
} from '@byok-grid/db';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const globalDatabase = globalThis as unknown as {
  byokGridSqliteDatabase?: ReturnType<typeof openSqliteDatabase>;
};

const databaseConfig = sqliteDatabaseConfigSchema.parse({
  ...(process.env.SQLITE_AUTH_TOKEN
    ? { authToken: process.env.SQLITE_AUTH_TOKEN }
    : {}),
  mode: process.env.BYOK_GRID_DATABASE_MODE,
  url: process.env.SQLITE_DATABASE_URL ?? defaultSqliteDatabaseUrl(),
});
if (databaseConfig.url.startsWith('file:')) {
  const path = databaseConfig.url.slice('file:'.length);
  mkdirSync(dirname(resolve(path)), { recursive: true });
}

const databasePromise =
  globalDatabase.byokGridSqliteDatabase ?? openSqliteDatabase(databaseConfig);

if (process.env.NODE_ENV !== 'production') {
  globalDatabase.byokGridSqliteDatabase = databasePromise;
}

export const sqliteDatabase = await databasePromise;

export const sqliteDb = sqliteDatabase.db;
