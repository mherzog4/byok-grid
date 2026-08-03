import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dbCredentials: {
    url: process.env.SQLITE_DATABASE_URL ?? './data/byok-grid.sqlite',
  },
  dialect: 'sqlite',
  out: './sqlite-migrations',
  schema: './src/sqlite/schema.ts',
  strict: true,
  verbose: true,
});
