import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  assertDistinctRemoteDatabases,
  assertMatchingRemoteDrillFingerprints,
  assertRemoteDrillConfirmation,
  assertRemoteDrillPreconditions,
  assertRemoteDrillProbe,
  createRemoteDrillIdentity,
  fingerprintRemoteDrillDatabase,
  parseRemoteDrillChallenge,
  parseRemoteDrillDatabaseConfig,
  parseRemoteDrillRunId,
  REMOTE_DRILL_CONFIRMATION,
  RemoteProductionDrillError,
  removeRemoteDrillProbe,
  writeRemoteDrillProbe,
} from './remote-production-drill';

describe('remote libSQL production drill', () => {
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    handle = await openSqliteDatabase({ url: ':memory:' });
    await migrateSqliteDatabase(handle.db);
  });

  afterEach(() => handle.close());

  it('requires authenticated, credential-free libsql URLs', () => {
    expect(
      parseRemoteDrillDatabaseConfig({
        authToken: 'secret-token',
        label: 'live',
        url: 'libsql://database.example.test',
      })
    ).toEqual({
      authToken: 'secret-token',
      url: 'libsql://database.example.test',
    });
    expect(
      parseRemoteDrillDatabaseConfig({
        authToken: 'secret-token',
        label: 'live',
        url: 'libsql://DATABASE.EXAMPLE.TEST/',
      }).url
    ).toBe('libsql://database.example.test');

    for (const input of [
      { authToken: 'secret-token', url: 'file:./local.sqlite' },
      { authToken: 'secret-token', url: 'https://database.example.test' },
      {
        authToken: 'secret-token',
        url: 'libsql://user:password@database.example.test',
      },
      {
        authToken: 'secret-token',
        url: 'libsql://database.example.test?token=secret',
      },
      {
        authToken: 'secret-token',
        url: 'libsql://database.example.test/database-name',
      },
      { authToken: '', url: 'libsql://database.example.test' },
    ]) {
      expect(() =>
        parseRemoteDrillDatabaseConfig({
          authToken: input.authToken,
          label: 'live',
          url: input.url,
        })
      ).toThrow(RemoteProductionDrillError);
    }
  });

  it('requires explicit isolated-database confirmation and distinct restore', () => {
    expect(() => assertRemoteDrillConfirmation(undefined)).toThrow(
      REMOTE_DRILL_CONFIRMATION
    );
    expect(() =>
      assertRemoteDrillConfirmation(REMOTE_DRILL_CONFIRMATION)
    ).not.toThrow();

    const live = {
      authToken: 'live-token',
      url: 'libsql://live.example.test',
    };
    expect(() => assertDistinctRemoteDatabases(live, live)).toThrow(
      /must differ/u
    );
    expect(() =>
      assertDistinctRemoteDatabases(live, {
        authToken: 'restore-token',
        url: 'libsql://restore.example.test',
      })
    ).not.toThrow();
    const alias = parseRemoteDrillDatabaseConfig({
      authToken: 'different-token',
      label: 'restored',
      url: 'libsql://LIVE.EXAMPLE.TEST/',
    });
    expect(() => assertDistinctRemoteDatabases(live, alias)).toThrow(
      /must differ/u
    );
  });

  it('validates and removes one exact probe on an empty migrated database', async () => {
    const identity = createRemoteDrillIdentity();
    expect(parseRemoteDrillRunId(identity.runId)).toBe(identity.runId);
    expect(parseRemoteDrillChallenge(identity.challengeSha256)).toBe(
      identity.challengeSha256
    );

    await expect(
      assertRemoteDrillPreconditions(handle.client)
    ).resolves.toBeUndefined();
    await writeRemoteDrillProbe(handle.client, identity);
    await expect(
      assertRemoteDrillProbe(handle.client, identity)
    ).resolves.toBeUndefined();

    const fingerprint = await fingerprintRemoteDrillDatabase(handle.client);
    expect(fingerprint.migrationCount).toBeGreaterThan(0);
    expect(fingerprint.migrationSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fingerprint.schemaSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(fingerprint.tableCountsSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(() =>
      assertMatchingRemoteDrillFingerprints(fingerprint, { ...fingerprint })
    ).not.toThrow();

    await removeRemoteDrillProbe(handle.client, identity);
    await expect(
      assertRemoteDrillPreconditions(handle.client)
    ).resolves.toBeUndefined();
  });

  it('rejects customer-like application data before creating a probe', async () => {
    await handle.client.execute({
      args: [randomUUID(), 'existing@example.test', 'Existing User'],
      sql: 'insert into users (id, email, name) values (?, ?, ?)',
    });

    await expect(assertRemoteDrillPreconditions(handle.client)).rejects.toThrow(
      /no application rows/u
    );
  });

  it('rejects a future migration suffix for release-specific evidence', async () => {
    await handle.client.execute({
      args: ['future-test-hash', 9_999_999_999_999],
      sql: 'insert into __drizzle_migrations (hash, created_at) values (?, ?)',
    });

    await expect(assertRemoteDrillPreconditions(handle.client)).rejects.toThrow(
      /unexpected migration count/u
    );
  });

  it('requires the exact run identity before cleanup', async () => {
    const identity = createRemoteDrillIdentity();
    await writeRemoteDrillProbe(handle.client, identity);

    await expect(
      removeRemoteDrillProbe(handle.client, {
        ...identity,
        challengeSha256: 'f'.repeat(64),
      })
    ).rejects.toThrow(/did not match/u);
    await expect(
      assertRemoteDrillProbe(handle.client, identity)
    ).resolves.toBeUndefined();
    await removeRemoteDrillProbe(handle.client, identity);
  });

  it('sanitizes underlying client failures', async () => {
    const secret = 'provider-error-containing-a-secret-token';
    const client = {
      execute: async () => {
        throw new Error(secret);
      },
    } as unknown as SqliteDatabaseHandle['client'];

    await expect(assertRemoteDrillPreconditions(client)).rejects.toThrow(
      'failed during preflight'
    );
    await expect(assertRemoteDrillPreconditions(client)).rejects.not.toThrow(
      secret
    );
  });

  it('rejects a mismatched restore fingerprint', () => {
    const baseline = {
      migrationCount: 9,
      migrationSha256: 'a'.repeat(64),
      schemaSha256: 'b'.repeat(64),
      tableCountsSha256: 'd'.repeat(64),
    };
    expect(() =>
      assertMatchingRemoteDrillFingerprints(baseline, {
        ...baseline,
        schemaSha256: 'c'.repeat(64),
      })
    ).toThrow(/did not match/u);
    expect(() =>
      assertMatchingRemoteDrillFingerprints(baseline, {
        ...baseline,
        tableCountsSha256: 'e'.repeat(64),
      })
    ).toThrow(/did not match/u);
  });

  it('does not expose rejected URLs or tokens through the CLI', () => {
    const secretToken = 'remote-auth-token-must-not-appear';
    const secretPath = '/tmp/remote-secret-database.sqlite';
    const cli = fileURLToPath(
      new URL('./remote-production-drill-cli.ts', import.meta.url)
    );
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', cli, 'prepare'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          BYOK_GRID_REMOTE_DRILL_CONFIRM: REMOTE_DRILL_CONFIRMATION,
          SQLITE_AUTH_TOKEN: secretToken,
          SQLITE_DATABASE_URL: `file:${secretPath}`,
        },
      }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/must use libsql:\/\//u);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secretToken);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secretPath);
  });
});
