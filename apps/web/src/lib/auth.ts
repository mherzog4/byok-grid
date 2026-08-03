import { ensureSqlitePersonalWorkspace } from '@byok-grid/db';
import * as schema from '@byok-grid/db/sqlite/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { PHASE_PRODUCTION_BUILD } from 'next/constants';
import { sqliteDb } from './sqlite-database';

const isProductionBuild = process.env.NEXT_PHASE === PHASE_PRODUCTION_BUILD;

export const auth = betterAuth({
  appName: 'BYOK Grid',
  baseURL:
    process.env.BETTER_AUTH_URL ??
    (isProductionBuild ? 'http://127.0.0.1:3000' : undefined),
  database: drizzleAdapter(sqliteDb, {
    provider: 'sqlite',
    schema,
    transaction: true,
    usePlural: true,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 12,
  },
  rateLimit: {
    enabled: true,
    storage: 'database',
  },
  secret:
    process.env.BETTER_AUTH_SECRET ??
    (isProductionBuild
      ? 'build-only-placeholder-never-used-at-runtime'
      : undefined),
  advanced: {
    database: {
      generateId: 'uuid',
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensureSqlitePersonalWorkspace(sqliteDb, {
            id: user.id,
            name: user.name,
          });
        },
      },
    },
  },
  telemetry: {
    enabled: false,
  },
});
