import {
  decryptCredential,
  parseMasterKey,
  unwrapWorkspaceKey,
} from '@byok-grid/security';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { credentials, users, workspaceKeys, workspaceMembers } from './schema';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const ownerId = 'vault-owner';
const memberId = 'vault-member';
const outsiderId = 'vault-outsider';

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

  it('pins a workspace to its original deployment master-key identifier', async () => {
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
    ).rejects.toBeInstanceOf(SqliteCredentialValidationError);
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

  function createMasterKey(id: string) {
    const key = parseMasterKey(id, randomBytes(32).toString('base64'));
    keys.push(key);
    return key;
  }
});
