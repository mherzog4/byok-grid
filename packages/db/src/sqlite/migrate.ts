import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { SqliteDatabase } from './client';

const defaultMigrationsFolder = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../sqlite-migrations'
);

export async function migrateSqliteDatabase(
  db: SqliteDatabase,
  migrationsFolder = defaultMigrationsFolder
): Promise<void> {
  await migrate(db, { migrationsFolder });
}
