import {
  ensureSqlitePersonalWorkspace,
  type SqliteDatabase,
} from '@byok-grid/db';
import * as schema from '@byok-grid/db/sqlite/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import type { SessionPolicy } from './session-policy';
import { signupPolicyAllowsEmail, type SignupPolicy } from './signup-policy';

export function createByokGridAuth({
  baseURL,
  database,
  secret,
  sessionPolicy,
  signupPolicy,
}: {
  baseURL: string | undefined;
  database: SqliteDatabase;
  secret: string | undefined;
  sessionPolicy: SessionPolicy;
  signupPolicy: SignupPolicy;
}) {
  return betterAuth({
    appName: 'BYOK Grid',
    baseURL,
    database: drizzleAdapter(database, {
      provider: 'sqlite',
      schema,
      transaction: true,
      usePlural: true,
    }),
    emailAndPassword: {
      disableSignUp: signupPolicy.mode === 'disabled',
      enabled: true,
      minPasswordLength: 12,
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
    },
    session: {
      cookieCache: { enabled: false },
      disableSessionRefresh: !sessionPolicy.refreshEnabled,
      expiresIn: sessionPolicy.expiresInSeconds,
      updateAge: sessionPolicy.updateAgeSeconds,
    },
    secret,
    advanced: {
      database: {
        generateId: 'uuid',
      },
      trustedProxyHeaders: false,
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!signupPolicyAllowsEmail(signupPolicy, user.email)) {
              throw new APIError('BAD_REQUEST', {
                code: 'SIGNUP_NOT_ALLOWED',
                message:
                  'Registration is not available for this email address.',
              });
            }
          },
          after: async (user) => {
            await ensureSqlitePersonalWorkspace(database, {
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
}
