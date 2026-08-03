import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDatabase } from './client';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const rootEnvFile = resolve(currentDirectory, '../../../.env');
if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'MIGRATION_DATABASE_URL (or DATABASE_URL) is required to apply migrations.'
  );
}

const { client, db } = createDatabase(databaseUrl);

try {
  await migrate(db, {
    migrationsFolder: resolve(currentDirectory, '../migrations'),
  });
} finally {
  await client.end();
}
