import {
  hasWorkspacePermission,
  type WorkspacePermission,
} from '@byok-grid/domain';
import {
  encryptCredential,
  generateWorkspaceKey,
  type MasterKey,
  type MasterKeyRing,
  masterKeyRingFromMasterKey,
  unwrapWorkspaceKeyFromRing,
} from '@byok-grid/security';
import { and, desc, eq } from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import { credentials, workspaceKeys, workspaceMembers } from './schema';

export class SqliteCredentialAccessError extends Error {}
export class SqliteCredentialValidationError extends Error {}

export interface SqliteCredentialMetadata {
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

type CredentialEncryptionKeys =
  | { masterKey: MasterKey; masterKeys?: never }
  | { masterKey?: never; masterKeys: MasterKeyRing };

export async function listSqliteCredentialMetadata(
  db: SqliteDatabase,
  scope: CredentialScope
): Promise<SqliteCredentialMetadata[]> {
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
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, credentials.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(eq(credentials.workspaceId, scope.workspaceId))
    .orderBy(desc(credentials.createdAt), desc(credentials.id));
}

export async function createSqliteEncryptedCredential(
  db: SqliteDatabase,
  input: CredentialScope &
    CredentialEncryptionKeys & {
      connectorId: string;
      name: string;
      secret: Readonly<Record<string, unknown>>;
    }
): Promise<SqliteCredentialMetadata> {
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new SqliteCredentialValidationError(
      'Credential names must contain 1 to 120 characters.'
    );
  }

  const masterKeys =
    input.masterKeys ?? masterKeyRingFromMasterKey(input.masterKey);

  return withSqliteWriteTransaction(db, async (tx) => {
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
          keyId: masterKeys.current.id,
          workspaceId: input.workspaceId,
          wrappedKey: generateWorkspaceKey(
            input.workspaceId,
            masterKeys.current
          ),
        })
        .onConflictDoNothing({ target: workspaceKeys.workspaceId });
      [storedKey] = await tx
        .select()
        .from(workspaceKeys)
        .where(eq(workspaceKeys.workspaceId, input.workspaceId))
        .limit(1);
    }
    if (!storedKey) throw new Error('The workspace key could not be created.');
    if (storedKey.keyId !== storedKey.wrappedKey.keyId) {
      throw new Error('The stored workspace key has inconsistent identifiers.');
    }

    const credentialId = crypto.randomUUID();
    const workspaceKey = unwrapWorkspaceKeyFromRing(
      input.workspaceId,
      storedKey.wrappedKey,
      masterKeys
    );
    try {
      const [created] = await tx
        .insert(credentials)
        .values({
          connectorId: input.connectorId,
          encryptedValue: encryptCredential(
            input.workspaceId,
            credentialId,
            workspaceKey,
            input.secret
          ),
          id: credentialId,
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

export async function revokeSqliteCredential(
  db: SqliteDatabase,
  scope: CredentialScope & { credentialId: string }
): Promise<SqliteCredentialMetadata> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireWorkspaceMembership(tx, scope, 'credentials.manage');
    const now = new Date();
    const [revoked] = await tx
      .update(credentials)
      .set({ revokedAt: now, updatedAt: now })
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
    if (!revoked) {
      throw new SqliteCredentialAccessError('Credential not found.');
    }
    return revoked;
  });
}

async function requireWorkspaceMembership(
  db: Pick<SqliteDatabase, 'select'>,
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
    throw new SqliteCredentialAccessError('Workspace not found.');
  }
}
