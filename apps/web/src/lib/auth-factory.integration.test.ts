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
  });
});

async function countRows(
  database: SqliteDatabaseHandle,
  table: string
): Promise<number> {
  const result = await database.client.execute(
    `select count(*) as count from ${table}`
  );
  return Number(result.rows[0]?.count ?? 0);
}
