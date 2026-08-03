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
import { resolveClientIpPolicy } from './client-ip-policy';
import { resolveEmailPolicy } from './email-policy';
import { resolveSessionPolicy } from './session-policy';
import { resolveSignupPolicy } from './signup-policy';

const baseURL = 'https://grid.example.com';
const secret = 'test-only-better-auth-secret-000000000';

describe('Better Auth client IP rate-limit integration', () => {
  let database: SqliteDatabaseHandle;
  let testDirectory: string;

  beforeEach(async () => {
    testDirectory = mkdtempSync(join(tmpdir(), 'byok-grid-auth-rate-limit-'));
    database = await openSqliteDatabase({
      url: `file:${join(testDirectory, 'auth.sqlite')}`,
    });
    await migrateSqliteDatabase(database.db);
  });

  afterEach(() => {
    database.close();
    rmSync(testDirectory, { force: true, recursive: true });
  });

  it('uses one fail-closed bucket when proxy trust is not configured', async () => {
    const auth = createAuth({});
    const responses = await sequentialAttempts(auth, [
      '198.51.100.1',
      '198.51.100.2',
      '198.51.100.3',
      '198.51.100.4',
    ]);

    expect(responses.slice(0, 3).map(({ status }) => status)).toEqual([
      401, 401, 401,
    ]);
    expect(responses[3]?.status).toBe(429);
  });

  it('walks a configured proxy chain from the right, ignoring spoofed left hops', async () => {
    const auth = createAuth({
      BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS: '10.20.0.0/16',
    });
    const responses = await sequentialAttempts(auth, [
      '203.0.113.1, 198.51.100.10, 10.20.0.5',
      '203.0.113.2, 198.51.100.10, 10.20.0.5',
      '203.0.113.3, 198.51.100.10, 10.20.0.5',
      '203.0.113.4, 198.51.100.10, 10.20.0.5',
    ]);

    expect(responses.slice(0, 3).map(({ status }) => status)).toEqual([
      401, 401, 401,
    ]);
    expect(responses[3]?.status).toBe(429);
  });

  it('keeps distinct real clients in distinct buckets behind trusted proxies', async () => {
    const auth = createAuth({
      BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS: '10.20.0.0/16',
    });
    const responses = await sequentialAttempts(auth, [
      '198.51.100.1, 10.20.0.5',
      '198.51.100.2, 10.20.0.5',
      '198.51.100.3, 10.20.0.5',
      '198.51.100.4, 10.20.0.5',
    ]);

    expect(responses.map(({ status }) => status)).toEqual([401, 401, 401, 401]);
  });

  function createAuth(environment: Record<string, string>) {
    return createByokGridAuth({
      baseURL,
      clientIpPolicy: resolveClientIpPolicy(environment),
      database: database.db,
      emailDelivery: undefined,
      emailPolicy: resolveEmailPolicy({}),
      secret,
      sessionPolicy: resolveSessionPolicy({ BETTER_AUTH_URL: baseURL }),
      signupPolicy: resolveSignupPolicy({
        BETTER_AUTH_URL: baseURL,
        BYOK_GRID_SIGNUP_MODE: 'disabled',
      }),
    });
  }
});

async function sequentialAttempts(
  auth: ReturnType<typeof createByokGridAuth>,
  forwardedForValues: readonly string[]
): Promise<Response[]> {
  const responses: Response[] = [];
  for (const forwardedFor of forwardedForValues) {
    responses.push(await signInAttempt(auth, forwardedFor));
  }
  return responses;
}

function signInAttempt(
  auth: ReturnType<typeof createByokGridAuth>,
  forwardedFor: string
): Promise<Response> {
  return auth.handler(
    new Request(`${baseURL}/api/auth/sign-in/email`, {
      body: JSON.stringify({
        email: 'missing@example.com',
        password: 'correct-horse-battery-staple',
      }),
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': forwardedFor,
      },
      method: 'POST',
    })
  );
}
