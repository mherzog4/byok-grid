import { openSqliteDatabase } from './client';
import { defaultSqliteDatabaseUrl, sqliteDatabaseConfigSchema } from './config';
import { migrateSqliteDatabase } from './migrate';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const databaseConfig = sqliteDatabaseConfigSchema.parse({
  ...(process.env.SQLITE_AUTH_TOKEN
    ? { authToken: process.env.SQLITE_AUTH_TOKEN }
    : {}),
  mode: process.env.BYOK_GRID_DATABASE_MODE,
  url: process.env.SQLITE_DATABASE_URL ?? defaultSqliteDatabaseUrl(),
});
if (databaseConfig.url.startsWith('file:')) {
  mkdirSync(dirname(resolve(databaseConfig.url.slice('file:'.length))), {
    recursive: true,
  });
}

const handle = await openSqliteDatabase(databaseConfig);

try {
  await migrateSqliteDatabase(handle.db);
} finally {
  handle.close();
}
