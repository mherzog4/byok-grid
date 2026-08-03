import {
  ensureSqlitePersonalWorkspace,
  type SqliteDatabase,
} from '@byok-grid/db';
import * as schema from '@byok-grid/db/sqlite/schema';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError } from 'better-auth/api';
import type { AuthenticationEmailDelivery } from './email-delivery';
import {
  AUTHENTICATION_LINK_EXPIRES_IN_SECONDS,
  emailDeliveryEnabled,
  type EmailPolicy,
} from './email-policy';
import type { SessionPolicy } from './session-policy';
import { signupPolicyAllowsEmail, type SignupPolicy } from './signup-policy';

export function createByokGridAuth({
  baseURL,
  database,
  emailDelivery,
  emailPolicy,
  secret,
  sessionPolicy,
  signupPolicy,
}: {
  baseURL: string | undefined;
  database: SqliteDatabase;
  emailDelivery: AuthenticationEmailDelivery | undefined;
  emailPolicy: EmailPolicy;
  secret: string | undefined;
  sessionPolicy: SessionPolicy;
  signupPolicy: SignupPolicy;
}) {
  if (emailDeliveryEnabled(emailPolicy) !== Boolean(emailDelivery)) {
    throw new Error('Email policy and delivery configuration do not match.');
  }

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
      maxPasswordLength: 128,
      minPasswordLength: 12,
      requireEmailVerification: emailDeliveryEnabled(emailPolicy),
      resetPasswordTokenExpiresIn: AUTHENTICATION_LINK_EXPIRES_IN_SECONDS,
      revokeSessionsOnPasswordReset: true,
      ...(emailDelivery
        ? {
            sendResetPassword: async ({ user, url }) =>
              deliverAuthenticationEmail(emailDelivery, {
                kind: 'password-reset',
                to: user.email,
                url,
              }),
          }
        : {}),
    },
    ...(emailDelivery
      ? {
          emailVerification: {
            autoSignInAfterVerification: true,
            expiresIn: AUTHENTICATION_LINK_EXPIRES_IN_SECONDS,
            sendOnSignIn: true,
            sendOnSignUp: true,
            sendVerificationEmail: async ({ user, url }) =>
              deliverAuthenticationEmail(emailDelivery, {
                kind: 'verify-email',
                to: user.email,
                url,
              }),
          },
        }
      : {}),
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

async function deliverAuthenticationEmail(
  delivery: AuthenticationEmailDelivery,
  message: Parameters<AuthenticationEmailDelivery['send']>[0]
): Promise<void> {
  try {
    await delivery.send(message);
  } catch {
    console.error('Authentication email delivery failed.', {
      kind: message.kind,
    });
  }
}
