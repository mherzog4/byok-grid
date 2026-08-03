import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'drizzle-kit';

const rootEnvFile = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../.env'
);
if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);

const databaseUrl =
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    'MIGRATION_DATABASE_URL (or DATABASE_URL) is required to generate or apply migrations.'
  );
}

export default defineConfig({
  dbCredentials: { url: databaseUrl },
  dialect: 'postgresql',
  out: './migrations',
  schema: './src/schema.ts',
  strict: true,
  verbose: true,
});
