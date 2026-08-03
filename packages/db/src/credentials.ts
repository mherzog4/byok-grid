import {
  encryptCredential,
  generateWorkspaceKey,
  type MasterKey,
  unwrapWorkspaceKey,
} from '@byok-grid/security';
import {
  hasWorkspacePermission,
  type WorkspacePermission,
} from '@byok-grid/domain';
import { and, desc, eq } from 'drizzle-orm';
import type { Database } from './client';
import { credentials, workspaceKeys, workspaceMembers } from './schema';

export class CredentialAccessError extends Error {}
export class CredentialValidationError extends Error {}

export interface CredentialMetadata {
  connectorId: string;
  createdAt: Date;
  id: string;
  lastUsedAt: Date | null;
  name: string;
  revokedAt: Date | null;
}

interface CredentialScope {
  userId: string;
  workspaceId: string;
}

type ReadDatabase = Pick<Database, 'select'>;

export async function listCredentialMetadata(
  db: Database,
  scope: CredentialScope
): Promise<CredentialMetadata[]> {
  await requireWorkspaceMembership(db, scope, 'data.read');
  return db
    .select({
      connectorId: credentials.connectorId,
      createdAt: credentials.createdAt,
      id: credentials.id,
      lastUsedAt: credentials.lastUsedAt,
      name: credentials.name,
      revokedAt: credentials.revokedAt,
    })
    .from(credentials)
    .where(eq(credentials.workspaceId, scope.workspaceId))
    .orderBy(desc(credentials.createdAt));
}

export async function createEncryptedCredential(
  db: Database,
  input: CredentialScope & {
    connectorId: string;
    masterKey: MasterKey;
    name: string;
    secret: Readonly<Record<string, unknown>>;
  }
): Promise<CredentialMetadata> {
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new CredentialValidationError(
      'Credential names must contain 1 to 120 characters.'
    );
  }

  return db.transaction(async (tx) => {
    await requireWorkspaceMembership(tx, input, 'credentials.manage');

    let [storedKey] = await tx
      .select()
      .from(workspaceKeys)
      .where(eq(workspaceKeys.workspaceId, input.workspaceId))
      .limit(1);

    if (!storedKey) {
      await tx
        .insert(workspaceKeys)
        .values({
          workspaceId: input.workspaceId,
          wrappedKey: generateWorkspaceKey(input.workspaceId, input.masterKey),
          keyId: input.masterKey.id,
        })
        .onConflictDoNothing({ target: workspaceKeys.workspaceId });
      [storedKey] = await tx
        .select()
        .from(workspaceKeys)
        .where(eq(workspaceKeys.workspaceId, input.workspaceId))
        .limit(1);
    }

    if (!storedKey) throw new Error('The workspace key could not be created.');
    if (storedKey.keyId !== input.masterKey.id) {
      throw new CredentialValidationError(
        `Master key ${storedKey.keyId} is required for this workspace.`
      );
    }

    const credentialId = crypto.randomUUID();
    const workspaceKey = unwrapWorkspaceKey(
      input.workspaceId,
      storedKey.wrappedKey,
      input.masterKey
    );
    try {
      const [created] = await tx
        .insert(credentials)
        .values({
          id: credentialId,
          connectorId: input.connectorId,
          encryptedValue: encryptCredential(
            input.workspaceId,
            credentialId,
            workspaceKey,
            input.secret
          ),
          name,
          workspaceId: input.workspaceId,
        })
        .returning({
          connectorId: credentials.connectorId,
          createdAt: credentials.createdAt,
          id: credentials.id,
          lastUsedAt: credentials.lastUsedAt,
          name: credentials.name,
          revokedAt: credentials.revokedAt,
        });
      if (!created) throw new Error('The credential could not be created.');
      return created;
    } finally {
      workspaceKey.fill(0);
    }
  });
}

export async function revokeCredential(
  db: Database,
  scope: CredentialScope & { credentialId: string }
): Promise<CredentialMetadata> {
  return db.transaction(async (tx) => {
    await requireWorkspaceMembership(tx, scope, 'credentials.manage');
    const [revoked] = await tx
      .update(credentials)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(credentials.id, scope.credentialId),
          eq(credentials.workspaceId, scope.workspaceId)
        )
      )
      .returning({
        connectorId: credentials.connectorId,
        createdAt: credentials.createdAt,
        id: credentials.id,
        lastUsedAt: credentials.lastUsedAt,
        name: credentials.name,
        revokedAt: credentials.revokedAt,
      });
    if (!revoked) throw new CredentialAccessError('Credential not found.');
    return revoked;
  });
}

async function requireWorkspaceMembership(
  db: ReadDatabase,
  scope: CredentialScope,
  permission: WorkspacePermission
): Promise<void> {
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.userId, scope.userId),
        eq(workspaceMembers.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  if (!membership || !hasWorkspacePermission(membership.role, permission)) {
    throw new CredentialAccessError('Workspace not found.');
  }
}
