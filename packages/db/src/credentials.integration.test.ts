import {
  decryptCredential,
  parseMasterKey,
  unwrapWorkspaceKey,
} from '@byok-grid/security';
import { eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  createEncryptedCredential,
  CredentialAccessError,
  ensurePersonalWorkspace,
  listCredentialMetadata,
  revokeCredential,
} from './index';
import {
  credentials,
  users,
  workspaceKeys,
  workspaceMembers,
  workspaces,
} from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('credential vault', () => {
  it('stores ciphertext, returns metadata, and enforces workspace access', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const masterKey = parseMasterKey(
      'integration-v1',
      randomBytes(32).toString('base64')
    );

    try {
      const [owner, member, outsider] = await db
        .insert(users)
        .values([
          {
            email: `vault-owner-${crypto.randomUUID()}@example.test`,
            name: 'Vault Owner',
          },
          {
            email: `vault-member-${crypto.randomUUID()}@example.test`,
            name: 'Vault Member',
          },
          {
            email: `vault-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Vault Outsider',
          },
        ])
        .returning({ id: users.id, name: users.name });
      expect(owner).toBeDefined();
      expect(member).toBeDefined();
      expect(outsider).toBeDefined();
      userIds.push(owner!.id, member!.id, outsider!.id);

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      await db.insert(workspaceMembers).values({
        role: 'member',
        userId: member!.id,
        workspaceId: workspace.id,
      });
      const metadata = await createEncryptedCredential(db, {
        connectorId: 'http',
        masterKey,
        name: 'Integration bearer',
        secret: { token: 'plaintext-must-not-persist', type: 'bearer' },
        userId: owner!.id,
        workspaceId: workspace.id,
      });

      const [storedCredential] = await db
        .select()
        .from(credentials)
        .where(eq(credentials.id, metadata.id));
      const [storedKey] = await db
        .select()
        .from(workspaceKeys)
        .where(eq(workspaceKeys.workspaceId, workspace.id));
      expect(storedCredential).toBeDefined();
      expect(storedKey).toBeDefined();
      expect(JSON.stringify(storedCredential!.encryptedValue)).not.toContain(
        'plaintext-must-not-persist'
      );

      const workspaceKey = unwrapWorkspaceKey(
        workspace.id,
        storedKey!.wrappedKey,
        masterKey
      );
      try {
        expect(
          decryptCredential(
            workspace.id,
            metadata.id,
            workspaceKey,
            storedCredential!.encryptedValue
          )
        ).toEqual({ token: 'plaintext-must-not-persist', type: 'bearer' });
      } finally {
        workspaceKey.fill(0);
      }

      const listed = await listCredentialMetadata(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        connectorId: 'http',
        id: metadata.id,
        name: 'Integration bearer',
        revokedAt: null,
      });
      expect(listed[0]).not.toHaveProperty('encryptedValue');

      await expect(
        listCredentialMetadata(db, {
          userId: member!.id,
          workspaceId: workspace.id,
        })
      ).resolves.toHaveLength(1);
      await expect(
        createEncryptedCredential(db, {
          connectorId: 'http',
          masterKey,
          name: 'Member credential',
          secret: { token: 'member-must-not-store', type: 'bearer' },
          userId: member!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(CredentialAccessError);
      await expect(
        revokeCredential(db, {
          credentialId: metadata.id,
          userId: member!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(CredentialAccessError);

      await expect(
        listCredentialMetadata(db, {
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(CredentialAccessError);

      const revoked = await revokeCredential(db, {
        credentialId: metadata.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(revoked.revokedAt).toBeInstanceOf(Date);
    } finally {
      if (workspaceIds.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      }
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }
      masterKey.value.fill(0);
      await client.end();
    }
  });
});
