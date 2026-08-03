import {
  migrateSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabaseHandle,
} from '@byok-grid/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticationEmailDelivery } from './email-delivery';
import { resolveClientIpPolicy } from './client-ip-policy';
import { resolveEmailPolicy } from './email-policy';
import { createByokGridAuth } from './auth-factory';
import { resolveSessionPolicy } from './session-policy';
import { resolveSignupPolicy } from './signup-policy';

const baseURL = 'https://grid.example.com';
const password = 'correct-horse-battery-staple';
const secret = 'test-only-better-auth-secret-000000000';
const disabledEmailPolicy = resolveEmailPolicy({});

describe('Better Auth signup policy integration', () => {
  let database: SqliteDatabaseHandle;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'byok-grid-auth-policy-'));
    database = await openSqliteDatabase({
      url: `file:${join(testDirectory, 'auth.sqlite')}`,
    });
    await migrateSqliteDatabase(database.db);
  });

  afterEach(() => {
    database.close();
    rmSync(testDirectory, { force: true, recursive: true });
  });

  it('rejects every account when registration is disabled', async () => {
    const auth = createByokGridAuth({
      baseURL,
      clientIpPolicy: resolveClientIpPolicy({}),
      database: database.db,
      emailDelivery: undefined,
      emailPolicy: disabledEmailPolicy,
      secret,
      sessionPolicy: resolveSessionPolicy({ BETTER_AUTH_URL: baseURL }),
      signupPolicy: resolveSignupPolicy({
        BETTER_AUTH_URL: baseURL,
        BYOK_GRID_SIGNUP_MODE: 'disabled',
      }),
    });

    const response = await auth.api.signUpEmail({
      asResponse: true,
      body: { email: 'owner@example.com', name: 'Owner', password },
    });

    expect(response.status).toBe(400);
    expect(await countRows(database, 'users')).toBe(0);
  });

  it('rejects non-allowlisted accounts but provisions an allowlisted owner', async () => {
    const auth = createByokGridAuth({
      baseURL,
      clientIpPolicy: resolveClientIpPolicy({}),
      database: database.db,
      emailDelivery: undefined,
      emailPolicy: disabledEmailPolicy,
      secret,
      sessionPolicy: resolveSessionPolicy({ BETTER_AUTH_URL: baseURL }),
      signupPolicy: resolveSignupPolicy({
        BETTER_AUTH_URL: baseURL,
        BYOK_GRID_SIGNUP_ALLOWED_EMAILS: 'owner@example.com',
        BYOK_GRID_SIGNUP_MODE: 'allowlist',
      }),
    });

    const rejected = await auth.api.signUpEmail({
      asResponse: true,
      body: { email: 'attacker@example.com', name: 'Attacker', password },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({
      code: 'SIGNUP_NOT_ALLOWED',
    });

    const accepted = await auth.api.signUpEmail({
      asResponse: true,
      body: { email: 'OWNER@example.com', name: 'Owner', password },
    });
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get('set-cookie')).toContain(
      'better-auth.session_token='
    );
    expect(await countRows(database, 'users')).toBe(1);
    expect(await countRows(database, 'workspaces')).toBe(1);
    expect(await countRows(database, 'workspace_members')).toBe(1);

    const firstCookie = cookieHeader(accepted);
    const secondLogin = await auth.api.signInEmail({
      asResponse: true,
      body: { email: 'owner@example.com', password },
    });
    expect(secondLogin.status).toBe(200);
    const secondCookie = cookieHeader(secondLogin);
    const secondHeaders = new Headers({ cookie: secondCookie });

    const sessions = await auth.api.listSessions({ headers: secondHeaders });
    expect(sessions).toHaveLength(2);
    for (const session of sessions) {
      const remaining = new Date(session.expiresAt).getTime() - Date.now();
      expect(remaining).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
      expect(remaining).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);
    }

    await expect(
      auth.api.revokeOtherSessions({ headers: secondHeaders })
    ).resolves.toEqual({ status: true });
    await expect(
      auth.api.getSession({ headers: new Headers({ cookie: firstCookie }) })
    ).resolves.toBeNull();
    await expect(
      auth.api.getSession({ headers: secondHeaders })
    ).resolves.toMatchObject({ user: { email: 'owner@example.com' } });
  });

  it('verifies email, issues one-time reset links, and revokes sessions after reset', async () => {
    const deliveries: Array<{
      kind: 'password-reset' | 'verify-email';
      to: string;
      url: string;
    }> = [];
    let failDelivery = false;
    const emailDelivery: AuthenticationEmailDelivery = {
      async send(message) {
        if (failDelivery) throw new Error('secret SMTP diagnostic');
        deliveries.push(message);
      },
      async verify() {},
    };
    const emailPolicy = resolveEmailPolicy({
      BYOK_GRID_EMAIL_MODE: 'smtp',
      SMTP_FROM_EMAIL: 'security@example.com',
      SMTP_HOST: 'smtp.example.com',
    });
    const auth = createByokGridAuth({
      baseURL,
      clientIpPolicy: resolveClientIpPolicy({}),
      database: database.db,
      emailDelivery,
      emailPolicy,
      secret,
      sessionPolicy: resolveSessionPolicy({ BETTER_AUTH_URL: baseURL }),
      signupPolicy: resolveSignupPolicy({
        BETTER_AUTH_URL: baseURL,
        BYOK_GRID_SIGNUP_ALLOWED_EMAILS: 'owner@example.com',
        BYOK_GRID_SIGNUP_MODE: 'allowlist',
      }),
    });

    const signup = await auth.api.signUpEmail({
      asResponse: true,
      body: { email: 'owner@example.com', name: 'Owner', password },
    });
    expect(signup.status).toBe(200);
    expect(signup.headers.get('set-cookie')).toBeNull();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      kind: 'verify-email',
      to: 'owner@example.com',
    });

    const verificationUrl = new URL(deliveries[0]!.url);
    const verificationToken = verificationUrl.searchParams.get('token');
    expect(verificationToken).toBeTruthy();
    await expect(
      auth.api.verifyEmail({ query: { token: verificationToken! } })
    ).resolves.toMatchObject({ status: true });

    const login = await auth.api.signInEmail({
      asResponse: true,
      body: { email: 'owner@example.com', password },
    });
    expect(login.status).toBe(200);
    const activeCookie = cookieHeader(login);

    await expect(
      auth.api.requestPasswordReset({
        body: { email: 'missing@example.com', redirectTo: '/reset-password' },
      })
    ).resolves.toMatchObject({ status: true });
    expect(deliveries).toHaveLength(1);

    await expect(
      auth.api.requestPasswordReset({
        body: { email: 'owner@example.com', redirectTo: '/reset-password' },
      })
    ).resolves.toMatchObject({ status: true });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).toMatchObject({
      kind: 'password-reset',
      to: 'owner@example.com',
    });
    const resetToken = new URL(deliveries[1]!.url).pathname.split('/').at(-1);
    expect(resetToken).toBeTruthy();

    const newPassword = 'new-correct-horse-battery-staple';
    await expect(
      auth.api.resetPassword({
        body: { newPassword, token: resetToken! },
      })
    ).resolves.toEqual({ status: true });
    await expect(
      auth.api.getSession({ headers: new Headers({ cookie: activeCookie }) })
    ).resolves.toBeNull();
    await expect(
      auth.api.resetPassword({
        body: { newPassword: `${newPassword}-again`, token: resetToken! },
      })
    ).rejects.toMatchObject({ status: 'BAD_REQUEST' });

    expect(
      (
        await auth.api.signInEmail({
          asResponse: true,
          body: { email: 'owner@example.com', password },
        })
      ).status
    ).toBe(401);
    expect(
      (
        await auth.api.signInEmail({
          asResponse: true,
          body: { email: 'owner@example.com', password: newPassword },
        })
      ).status
    ).toBe(200);

    failDelivery = true;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const knownDuringOutage = await auth.api.requestPasswordReset({
      body: { email: 'owner@example.com', redirectTo: '/reset-password' },
    });
    const unknownDuringOutage = await auth.api.requestPasswordReset({
      body: {
        email: 'another-missing@example.com',
        redirectTo: '/reset-password',
      },
    });
    expect(knownDuringOutage).toEqual(unknownDuringOutage);
    expect(errorLog).toHaveBeenCalledWith(
      'Authentication email delivery failed.',
      { kind: 'password-reset' }
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      'secret SMTP diagnostic'
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      'owner@example.com'
    );
    errorLog.mockRestore();
  });
});

function cookieHeader(response: Response): string {
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';', 1)[0])
    .join('; ');
  if (!cookie) throw new Error('Better Auth did not return a session cookie.');
  return cookie;
}

async function countRows(
  database: SqliteDatabaseHandle,
  table: string
): Promise<number> {
  const result = await database.client.execute(
    `select count(*) as count from ${table}`
  );
  return Number(result.rows[0]?.count ?? 0);
}
