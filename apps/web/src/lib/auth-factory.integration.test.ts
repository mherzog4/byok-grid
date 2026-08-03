import {
  migrateSqliteDatabase,
  openSqliteDatabase,
  type SqliteDatabaseHandle,
} from '@byok-grid/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createByokGridAuth } from './auth-factory';
import { resolveSessionPolicy } from './session-policy';
import { resolveSignupPolicy } from './signup-policy';

const baseURL = 'https://grid.example.com';
const password = 'correct-horse-battery-staple';
const secret = 'test-only-better-auth-secret-000000000';

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
      database: database.db,
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
      database: database.db,
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
