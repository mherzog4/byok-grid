import {
  connectorExecutionIsRevoked,
  connectorRevocationIdSchema,
  connectorRevocationTargetKey,
  createConnectorRevocationRequestSchema,
  hasWorkspacePermission,
  liftConnectorRevocationRequestSchema,
  type ActiveConnectorRevocation,
  type ConnectorExecutionIdentity,
  type ConnectorRevocationTarget,
  type WorkspacePermission,
} from '@byok-grid/domain';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  type SqliteDatabase,
  type SqliteTransaction,
  withSqliteWriteTransaction,
} from './client';
import { connectorRevocations, workspaceMembers } from './schema';

export class SqliteConnectorRevocationAccessError extends Error {}
export class SqliteConnectorRevocationConflictError extends Error {}
export class SqliteConnectorRevokedError extends Error {}
export class SqliteConnectorRevocationValidationError extends Error {}

interface WorkspaceScope {
  userId: string;
  workspaceId: string;
}

type RevocationExecutor = Pick<SqliteDatabase, 'select'>;

export interface SqliteConnectorRevocationSummary {
  createdAt: Date;
  createdByUserId: string | null;
  id: string;
  liftedAt: Date | null;
  liftedByUserId: string | null;
  reason: string;
  target: ConnectorRevocationTarget;
  targetKey: string;
}

export async function listSqliteWorkspaceConnectorRevocations(
  db: SqliteDatabase,
  scope: WorkspaceScope
): Promise<SqliteConnectorRevocationSummary[]> {
  await requireWorkspacePermission(db, scope, 'data.read');
  return db
    .select({
      createdAt: connectorRevocations.createdAt,
      createdByUserId: connectorRevocations.createdByUserId,
      id: connectorRevocations.id,
      liftedAt: connectorRevocations.liftedAt,
      liftedByUserId: connectorRevocations.liftedByUserId,
      reason: connectorRevocations.reason,
      target: connectorRevocations.target,
      targetKey: connectorRevocations.targetKey,
    })
    .from(connectorRevocations)
    .where(eq(connectorRevocations.workspaceId, scope.workspaceId))
    .orderBy(
      desc(connectorRevocations.createdAt),
      desc(connectorRevocations.id)
    );
}

export async function createSqliteWorkspaceConnectorRevocation(
  db: SqliteDatabase,
  input: WorkspaceScope & {
    reason: string;
    target: ConnectorRevocationTarget;
  },
  now = new Date()
): Promise<SqliteConnectorRevocationSummary> {
  const request = createConnectorRevocationRequestSchema.parse({
    reason: input.reason,
    target: input.target,
  });
  const targetKey = connectorRevocationTargetKey(request.target);
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireWorkspacePermission(tx, input, 'connectors.manage');
    const [created] = await tx
      .insert(connectorRevocations)
      .values({
        createdAt: now,
        createdByUserId: input.userId,
        reason: request.reason,
        target: request.target,
        targetKey,
        updatedAt: now,
        workspaceId: input.workspaceId,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) {
      throw new SqliteConnectorRevocationConflictError(
        `${targetKey} already has an active revocation.`
      );
    }
    return created;
  });
}

export async function liftSqliteWorkspaceConnectorRevocation(
  db: SqliteDatabase,
  input: WorkspaceScope & {
    confirmationTargetKey: string;
    revocationId: string;
  },
  now = new Date()
): Promise<SqliteConnectorRevocationSummary> {
  const revocationId = connectorRevocationIdSchema.parse(input.revocationId);
  const request = liftConnectorRevocationRequestSchema.parse({
    confirmationTargetKey: input.confirmationTargetKey,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireWorkspacePermission(tx, input, 'connectors.manage');
    const [current] = await tx
      .select({ targetKey: connectorRevocations.targetKey })
      .from(connectorRevocations)
      .where(
        and(
          eq(connectorRevocations.id, revocationId),
          eq(connectorRevocations.workspaceId, input.workspaceId),
          isNull(connectorRevocations.liftedAt)
        )
      )
      .limit(1);
    if (!current) {
      throw new SqliteConnectorRevocationAccessError(
        'The active connector revocation was not found.'
      );
    }
    if (request.confirmationTargetKey !== current.targetKey) {
      throw new SqliteConnectorRevocationValidationError(
        `Type ${current.targetKey} exactly to lift this revocation.`
      );
    }
    const [lifted] = await tx
      .update(connectorRevocations)
      .set({
        liftedAt: now,
        liftedByUserId: input.userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(connectorRevocations.id, revocationId),
          eq(connectorRevocations.workspaceId, input.workspaceId),
          isNull(connectorRevocations.liftedAt)
        )
      )
      .returning();
    if (!lifted) {
      throw new SqliteConnectorRevocationConflictError(
        'The connector revocation changed while it was being lifted.'
      );
    }
    return lifted;
  });
}

export async function getActiveSqliteConnectorRevocations(
  db: RevocationExecutor,
  workspaceId: string
): Promise<ActiveConnectorRevocation[]> {
  return db
    .select({
      id: connectorRevocations.id,
      target: connectorRevocations.target,
    })
    .from(connectorRevocations)
    .where(
      and(
        eq(connectorRevocations.workspaceId, workspaceId),
        isNull(connectorRevocations.liftedAt)
      )
    );
}

export async function requireSqliteConnectorExecutionAllowed(
  db: RevocationExecutor,
  workspaceId: string,
  identity: ConnectorExecutionIdentity
): Promise<void> {
  const revocations = await getActiveSqliteConnectorRevocations(
    db,
    workspaceId
  );
  if (connectorExecutionIsRevoked(identity, revocations)) {
    throw new SqliteConnectorRevokedError(
      `Connector ${identity.connectorId}@${identity.connectorVersion} is revoked in this workspace.`
    );
  }
}

async function requireWorkspacePermission(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  scope: WorkspaceScope,
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
    throw new SqliteConnectorRevocationAccessError('Workspace not found.');
  }
}
