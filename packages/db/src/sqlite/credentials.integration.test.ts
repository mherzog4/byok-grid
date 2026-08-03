import {
  decryptCredential,
  parseMasterKey,
  parseMasterKeyRing,
  unwrapWorkspaceKey,
} from '@byok-grid/security';
import { eq } from 'drizzle-orm';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import {
  createSqliteEncryptedCredential,
  listSqliteCredentialMetadata,
  revokeSqliteCredential,
  SqliteCredentialAccessError,
  SqliteCredentialValidationError,
} from './credentials';
import { migrateSqliteDatabase } from './migrate';
import {
  inspectSqliteMasterKeyRotation,
  rotateSqliteMasterKeysBatch,
} from './master-key-rotation';
import { credentials, users, workspaceKeys, workspaceMembers } from './schema';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const ownerId = 'vault-owner';
const memberId = 'vault-member';
const outsiderId = 'vault-outsider';
const execFileAsync = promisify(execFile);
const rotationCliPath = new URL('./master-key-rotation-cli.ts', import.meta.url)
  .pathname;
const repositoryRoot = new URL('../../../../', import.meta.url).pathname;

describe('SQLite BYOK credential vault', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let workspaceId: string;
  const keys: Array<ReturnType<typeof parseMasterKey>> = [];

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-vault-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values([
      { email: 'vault-owner@example.test', id: ownerId, name: 'Vault Owner' },
      {
        email: 'vault-member@example.test',
        id: memberId,
        name: 'Vault Member',
      },
      {
        email: 'vault-outsider@example.test',
        id: outsiderId,
        name: 'Vault Outsider',
      },
    ]);
    workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: ownerId,
        name: 'Vault Owner',
      })
    ).id;
    await handle.db.insert(workspaceMembers).values({
      role: 'member',
      userId: memberId,
      workspaceId,
    });
  });

  afterEach(() => {
    for (const key of keys.splice(0)) key.value.fill(0);
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('stores authenticated ciphertext and returns metadata only', async () => {
    const masterKey = createMasterKey('integration-v1');
    const [bearer, apiKey] = await Promise.all([
      createSqliteEncryptedCredential(handle.db, {
        connectorId: 'http',
        masterKey,
        name: '  Integration bearer  ',
        secret: { token: 'plaintext-must-not-persist', type: 'bearer' },
        userId: ownerId,
        workspaceId,
      }),
      createSqliteEncryptedCredential(handle.db, {
        connectorId: 'apollo',
        masterKey,
        name: 'Apollo key',
        secret: { apiKey: 'second-plaintext-secret' },
        userId: ownerId,
        workspaceId,
      }),
    ]);
    expect(bearer.name).toBe('Integration bearer');

    const storedCredentials = await handle.db
      .select()
      .from(credentials)
      .where(eq(credentials.workspaceId, workspaceId));
    const [storedKey] = await handle.db
      .select()
      .from(workspaceKeys)
      .where(eq(workspaceKeys.workspaceId, workspaceId));
    expect(storedCredentials).toHaveLength(2);
    expect(storedKey?.keyId).toBe(masterKey.id);
    expect(JSON.stringify(storedCredentials)).not.toContain(
      'plaintext-must-not-persist'
    );
    expect(JSON.stringify(storedCredentials)).not.toContain(
      'second-plaintext-secret'
    );

    const workspaceKey = unwrapWorkspaceKey(
      workspaceId,
      storedKey!.wrappedKey,
      masterKey
    );
    try {
      const byId = new Map(storedCredentials.map((item) => [item.id, item]));
      expect(
        decryptCredential(
          workspaceId,
          bearer.id,
          workspaceKey,
          byId.get(bearer.id)!.encryptedValue
        )
      ).toEqual({ token: 'plaintext-must-not-persist', type: 'bearer' });
      expect(
        decryptCredential(
          workspaceId,
          apiKey.id,
          workspaceKey,
          byId.get(apiKey.id)!.encryptedValue
        )
      ).toEqual({ apiKey: 'second-plaintext-secret' });
    } finally {
      workspaceKey.fill(0);
    }

    const listed = await listSqliteCredentialMetadata(handle.db, {
      userId: memberId,
      workspaceId,
    });
    expect(listed).toHaveLength(2);
    expect(listed[0]).not.toHaveProperty('encryptedValue');
    expect(JSON.stringify(listed)).not.toContain('plaintext');

    await expect(
      createSqliteEncryptedCredential(handle.db, {
        connectorId: 'http',
        masterKey,
        name: 'Member credential',
        secret: { token: 'member-secret' },
        userId: memberId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCredentialAccessError);
    await expect(
      revokeSqliteCredential(handle.db, {
        credentialId: bearer.id,
        userId: memberId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCredentialAccessError);
    await expect(
      listSqliteCredentialMetadata(handle.db, {
        userId: outsiderId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCredentialAccessError);

    const revoked = await revokeSqliteCredential(handle.db, {
      credentialId: bearer.id,
      userId: ownerId,
      workspaceId,
    });
    expect(revoked.revokedAt).toBeInstanceOf(Date);
  });

  it('requires the original master key until a rotation overlap is configured', async () => {
    const original = createMasterKey('integration-v1');
    const replacement = createMasterKey('integration-v2');
    await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'http',
      masterKey: original,
      name: 'Original',
      secret: { token: 'first' },
      userId: ownerId,
      workspaceId,
    });

    await expect(
      createSqliteEncryptedCredential(handle.db, {
        connectorId: 'http',
        masterKey: replacement,
        name: 'Wrong key',
        secret: { token: 'second' },
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toThrow('The required master key is not available.');
    await expect(
      createSqliteEncryptedCredential(handle.db, {
        connectorId: 'http',
        masterKey: original,
        name: ' ',
        secret: { token: 'third' },
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCredentialValidationError);
  });

  it('rewraps workspace keys in bounded idempotent batches without rewriting credentials', async () => {
    const original = createMasterKey('integration-v1');
    const replacement = createMasterKey('integration-v2');
    const first = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'http',
      masterKey: original,
      name: 'Before rotation',
      secret: { token: 'first-secret' },
      userId: ownerId,
      workspaceId,
    });
    const masterKeys = parseMasterKeyRing(
      replacement.id,
      replacement.value.toString('base64'),
      JSON.stringify({ [original.id]: original.value.toString('base64') })
    );
    const second = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'http',
      masterKeys,
      name: 'During overlap',
      secret: { token: 'second-secret' },
      userId: ownerId,
      workspaceId,
    });
    const ciphertextBefore = await handle.db
      .select({
        encryptedValue: credentials.encryptedValue,
        id: credentials.id,
      })
      .from(credentials)
      .where(eq(credentials.workspaceId, workspaceId));

    await expect(
      inspectSqliteMasterKeyRotation(handle.db, masterKeys)
    ).resolves.toEqual({ pending: 1, total: 1 });
    await expect(
      rotateSqliteMasterKeysBatch(handle.db, masterKeys, 1)
    ).resolves.toEqual({ remaining: 0, rotated: 1 });
    await expect(
      rotateSqliteMasterKeysBatch(handle.db, masterKeys, 1)
    ).resolves.toEqual({ remaining: 0, rotated: 0 });

    const [storedKey] = await handle.db
      .select()
      .from(workspaceKeys)
      .where(eq(workspaceKeys.workspaceId, workspaceId));
    expect(storedKey?.keyId).toBe(replacement.id);
    expect(storedKey?.wrappedKey.keyId).toBe(replacement.id);
    expect(
      await handle.db
        .select({
          encryptedValue: credentials.encryptedValue,
          id: credentials.id,
        })
        .from(credentials)
        .where(eq(credentials.workspaceId, workspaceId))
    ).toEqual(ciphertextBefore);

    const workspaceKey = unwrapWorkspaceKey(
      workspaceId,
      storedKey!.wrappedKey,
      replacement
    );
    try {
      const byId = new Map(ciphertextBefore.map((item) => [item.id, item]));
      expect(
        decryptCredential(
          workspaceId,
          first.id,
          workspaceKey,
          byId.get(first.id)!.encryptedValue
        )
      ).toEqual({ token: 'first-secret' });
      expect(
        decryptCredential(
          workspaceId,
          second.id,
          workspaceKey,
          byId.get(second.id)!.encryptedValue
        )
      ).toEqual({ token: 'second-secret' });
    } finally {
      workspaceKey.fill(0);
    }

    await expect(
      inspectSqliteMasterKeyRotation(
        handle.db,
        parseMasterKeyRing(replacement.id, replacement.value.toString('base64'))
      )
    ).resolves.toEqual({ pending: 0, total: 1 });
  });

  it('stops before mutation when an old key is unavailable or identifiers disagree', async () => {
    const original = createMasterKey('integration-v1');
    const replacement = createMasterKey('integration-v2');
    await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'http',
      masterKey: original,
      name: 'Unavailable old key',
      secret: { token: 'must-remain-readable' },
      userId: ownerId,
      workspaceId,
    });
    const incompleteRing = parseMasterKeyRing(
      replacement.id,
      replacement.value.toString('base64')
    );

    await expect(
      inspectSqliteMasterKeyRotation(handle.db, incompleteRing)
    ).rejects.toThrow('The required master key is not available.');
    await expect(
      rotateSqliteMasterKeysBatch(handle.db, incompleteRing)
    ).rejects.toThrow('The required master key is not available.');
    let [storedKey] = await handle.db
      .select()
      .from(workspaceKeys)
      .where(eq(workspaceKeys.workspaceId, workspaceId));
    expect(storedKey?.keyId).toBe(original.id);

    await handle.db
      .update(workspaceKeys)
      .set({ keyId: replacement.id })
      .where(eq(workspaceKeys.workspaceId, workspaceId));
    const completeRing = parseMasterKeyRing(
      replacement.id,
      replacement.value.toString('base64'),
      JSON.stringify({ [original.id]: original.value.toString('base64') })
    );
    await expect(
      inspectSqliteMasterKeyRotation(handle.db, completeRing)
    ).rejects.toThrow('inconsistent key identifiers');
    await expect(
      rotateSqliteMasterKeysBatch(handle.db, completeRing)
    ).rejects.toThrow('inconsistent key identifiers');
    [storedKey] = await handle.db
      .select()
      .from(workspaceKeys)
      .where(eq(workspaceKeys.workspaceId, workspaceId));
    expect(storedKey?.wrappedKey.keyId).toBe(original.id);
  });

  it('plans and applies rotation through the operator CLI without exposing key material', async () => {
    const original = createMasterKey('integration-v1');
    const replacement = createMasterKey('integration-v2');
    await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'http',
      masterKey: original,
      name: 'CLI rotation',
      secret: { token: 'cli-secret' },
      userId: ownerId,
      workspaceId,
    });
    const environment = {
      ...process.env,
      BYOK_GRID_ADDITIONAL_MASTER_KEYS: JSON.stringify({
        [original.id]: original.value.toString('base64'),
      }),
      BYOK_GRID_MASTER_KEY: replacement.value.toString('base64'),
      BYOK_GRID_MASTER_KEY_ID: replacement.id,
      SQLITE_DATABASE_URL: `file:${databasePath}`,
    };

    const plan = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', rotationCliPath, 'plan'],
      { cwd: repositoryRoot, encoding: 'utf8', env: environment }
    );
    expect(JSON.parse(String(plan.stdout))).toEqual({
      currentKeyId: replacement.id,
      marker: 'BYOK_GRID_MASTER_KEY_ROTATION_PLAN_VALID',
      pending: 1,
      total: 1,
    });
    expect(String(plan.stdout)).not.toContain(
      replacement.value.toString('base64')
    );
    expect(String(plan.stdout)).not.toContain(
      original.value.toString('base64')
    );

    let wrongConfirmation: unknown;
    try {
      await execFileAsync(
        process.execPath,
        ['--import', 'tsx', rotationCliPath, 'apply', original.id],
        { cwd: repositoryRoot, encoding: 'utf8', env: environment }
      );
    } catch (error) {
      wrongConfirmation = error;
    }
    expect(wrongConfirmation).toMatchObject({ code: 1 });
    expect(
      String((wrongConfirmation as { stderr?: unknown }).stderr)
    ).not.toContain(replacement.value.toString('base64'));

    const applied = await execFileAsync(
      process.execPath,
      ['--import', 'tsx', rotationCliPath, 'apply', replacement.id],
      { cwd: repositoryRoot, encoding: 'utf8', env: environment }
    );
    expect(JSON.parse(String(applied.stdout))).toEqual({
      currentKeyId: replacement.id,
      marker: 'BYOK_GRID_MASTER_KEY_ROTATION_APPLIED',
      remaining: 0,
      rotated: 1,
      total: 1,
    });
  });

  function createMasterKey(id: string) {
    const key = parseMasterKey(id, randomBytes(32).toString('base64'));
    keys.push(key);
    return key;
  }
});
