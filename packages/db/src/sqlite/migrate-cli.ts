import { openSqliteDatabase } from './client';
import { defaultSqliteDatabaseUrl } from './config';
import { migrateSqliteDatabase } from './migrate';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const sqliteUrl = process.env.SQLITE_DATABASE_URL ?? defaultSqliteDatabaseUrl();
if (sqliteUrl.startsWith('file:')) {
  mkdirSync(dirname(resolve(sqliteUrl.slice('file:'.length))), {
    recursive: true,
  });
}

const handle = await openSqliteDatabase({
  ...(process.env.SQLITE_AUTH_TOKEN
    ? { authToken: process.env.SQLITE_AUTH_TOKEN }
    : {}),
  url: sqliteUrl,
});

try {
  await migrateSqliteDatabase(handle.db);
} finally {
  handle.close();
}
