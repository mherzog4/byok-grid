import {
  hasWorkspacePermission,
  type WorkspacePermission,
} from '@byok-grid/domain';
import {
  encryptCredential,
  generateWorkspaceKey,
  type MasterKey,
  unwrapWorkspaceKey,
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
  input: CredentialScope & {
    connectorId: string;
    masterKey: MasterKey;
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
          keyId: input.masterKey.id,
          workspaceId: input.workspaceId,
          wrappedKey: generateWorkspaceKey(input.workspaceId, input.masterKey),
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
      throw new SqliteCredentialValidationError(
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
