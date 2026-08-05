import {
  hasWorkspacePermission,
  workspacePurgeConfirmationMatches,
  workspacePurgeRequestSchema,
  type WorkspacePurgeImpact,
  type WorkspacePurgeRequest,
  type WorkspacePurgeReason,
} from '@byok-grid/domain';
import { and, asc, eq, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import {
  bulkRunBatches,
  cellRuns,
  cells,
  columns,
  connectorRevocations,
  credentials,
  dataTables,
  importJobs,
  ingestionBatches,
  ingestionEndpoints,
  outboxEvents,
  rows,
  rowSettlements,
  schemaLifecycleEvents,
  sourceDefinitions,
  sourceRuns,
  usageLedger,
  webhookDeliveries,
  webhookDestinations,
  workspaceInvitations,
  workspaceMembers,
  workspacePurgeHolds,
  workspacePurgeReceipts,
  workspaces,
  writebackDeliveries,
  writebackDestinations,
  users,
} from './schema';

export class SqliteWorkspacePurgeAccessError extends Error {}
export class SqliteWorkspacePurgeConflictError extends Error {}
export class SqliteWorkspacePurgeValidationError extends Error {}

export interface SqliteWorkspacePurgeBlocker {
  code: 'active_work' | 'legal_hold';
  count: number;
  message: string;
}

export interface SqliteWorkspacePurgePreview {
  blockers: SqliteWorkspacePurgeBlocker[];
  canPurge: boolean;
  impact: WorkspacePurgeImpact;
  previewDigest: string;
  receipt: {
    retainedFields: readonly [
      'receiptId',
      'workspaceId',
      'actorUserId',
      'reason',
      'impact',
      'previewDigest',
      'purgedAt',
      'analyticsErasureState',
    ];
  };
  workspace: { id: string; name: string };
}

export interface SqliteWorkspacePurgeReceipt {
  actorUserId: string | null;
  id: string;
  impact: WorkspacePurgeImpact;
  purgedAt: Date;
  reason: WorkspacePurgeReason;
  workspaceId: string;
}

interface SqliteWorkspaceScope {
  userId: string;
  workspaceId: string;
}

export interface SqliteWorkspaceSummary {
  id: string;
  name: string;
  role: 'admin' | 'member' | 'owner';
  slug: string;
}

export interface SqliteLocalUser {
  email: string;
  id: string;
  name: string;
}

export async function ensureSqliteLocalUser(
  db: SqliteDatabase,
  user: Readonly<SqliteLocalUser>
): Promise<void> {
  await withSqliteWriteTransaction(db, async (tx) => {
    await tx
      .insert(users)
      .values({
        email: user.email,
        emailVerified: true,
        id: user.id,
        name: user.name,
      })
      .onConflictDoNothing();

    const [stored] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, user.id))
      .limit(1);
    if (!stored) {
      throw new Error('The local workspace owner could not be provisioned.');
    }
  });
}

export async function listSqliteUserWorkspaces(
  db: SqliteDatabase,
  userId: string
): Promise<SqliteWorkspaceSummary[]> {
  return db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMembers.role,
      slug: workspaces.slug,
    })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
}

export async function ensureSqlitePersonalWorkspace(
  db: SqliteDatabase,
  user: Readonly<{ id: string; name: string }>
): Promise<SqliteWorkspaceSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [existing] = await tx
      .select({
        id: workspaces.id,
        name: workspaces.name,
        role: workspaceMembers.role,
        slug: workspaces.slug,
      })
      .from(workspaceMembers)
      .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
      .where(eq(workspaceMembers.userId, user.id))
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(1);
    if (existing) return existing;

    const [workspace] = await tx
      .insert(workspaces)
      .values({
        name: `${user.name}'s workspace`,
        slug: `personal-${user.id}`,
      })
      .returning({
        id: workspaces.id,
        name: workspaces.name,
        slug: workspaces.slug,
      });
    if (!workspace) {
      throw new Error('The personal workspace could not be created.');
    }

    await tx.insert(workspaceMembers).values({
      role: 'owner',
      userId: user.id,
      workspaceId: workspace.id,
    });
    const [starterTable] = await tx
      .insert(dataTables)
      .values({ name: 'Companies', workspaceId: workspace.id })
      .returning({ id: dataTables.id });
    if (!starterTable) {
      throw new Error('The starter table could not be created.');
    }
    await tx.insert(columns).values([
      {
        kind: 'input',
        name: 'Company',
        position: 'a0',
        tableId: starterTable.id,
        valueType: 'text',
        workspaceId: workspace.id,
      },
      {
        kind: 'input',
        name: 'Domain',
        position: 'a1',
        tableId: starterTable.id,
        valueType: 'text',
        workspaceId: workspace.id,
      },
    ]);

    return { ...workspace, role: 'owner' };
  });
}

export async function previewSqliteWorkspacePurge(
  db: SqliteDatabase,
  scope: SqliteWorkspaceScope
): Promise<SqliteWorkspacePurgePreview> {
  return withSqliteWriteTransaction(db, (tx) =>
    buildSqliteWorkspacePurgePreview(tx, scope)
  );
}

export async function purgeSqliteWorkspace(
  db: SqliteDatabase,
  input: SqliteWorkspaceScope & WorkspacePurgeRequest
): Promise<SqliteWorkspacePurgeReceipt> {
  const parsed = workspacePurgeRequestSchema.safeParse({
    acknowledgeIrreversible: input.acknowledgeIrreversible,
    confirmationName: input.confirmationName,
    previewDigest: input.previewDigest,
    reason: input.reason,
  });
  if (!parsed.success) {
    throw new SqliteWorkspacePurgeValidationError(
      parsed.error.issues[0]?.message ?? 'The purge confirmation is invalid.'
    );
  }

  return withSqliteWriteTransaction(db, async (tx) => {
    const preview = await buildSqliteWorkspacePurgePreview(tx, input);
    if (
      !workspacePurgeConfirmationMatches(
        preview.workspace.name,
        parsed.data.confirmationName
      )
    ) {
      throw new SqliteWorkspacePurgeValidationError(
        'Type the exact workspace name to confirm permanent deletion.'
      );
    }
    if (preview.previewDigest !== parsed.data.previewDigest) {
      throw new SqliteWorkspacePurgeConflictError(
        'The workspace changed after the preview. Review the refreshed impact before trying again.'
      );
    }
    if (preview.blockers.length > 0) {
      throw new SqliteWorkspacePurgeConflictError(preview.blockers[0]!.message);
    }

    const now = new Date();
    const [receipt] = await tx
      .insert(workspacePurgeReceipts)
      .values({
        actorUserId: input.userId,
        impact: preview.impact,
        previewDigest: preview.previewDigest,
        purgedAt: now,
        reason: parsed.data.reason,
        workspaceId: input.workspaceId,
      })
      .returning({
        actorUserId: workspacePurgeReceipts.actorUserId,
        id: workspacePurgeReceipts.id,
        impact: workspacePurgeReceipts.impact,
        purgedAt: workspacePurgeReceipts.purgedAt,
        reason: workspacePurgeReceipts.reason,
        workspaceId: workspacePurgeReceipts.workspaceId,
      });
    if (!receipt) throw new Error('The purge receipt could not be created.');

    const [deleted] = await tx
      .delete(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .returning({ id: workspaces.id });
    if (!deleted) {
      throw new SqliteWorkspacePurgeAccessError(
        'The workspace could not be permanently deleted.'
      );
    }
    return receipt;
  });
}

async function buildSqliteWorkspacePurgePreview(
  db: Pick<SqliteDatabase, 'select'>,
  scope: SqliteWorkspaceScope
): Promise<SqliteWorkspacePurgePreview> {
  const [workspace] = await db
    .select({
      id: workspaces.id,
      name: workspaces.name,
      role: workspaceMembers.role,
      updatedAt: workspaces.updatedAt,
    })
    .from(workspaces)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workspaces.id),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(eq(workspaces.id, scope.workspaceId))
    .limit(1);
  if (
    !workspace ||
    !hasWorkspacePermission(workspace.role, 'workspace.manage')
  ) {
    throw new SqliteWorkspacePurgeAccessError('The workspace was not found.');
  }

  const [counts] = await db
    .select({
      activeWork: sql<number>`(
        (select count(*) from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.status} in ('queued', 'running')) +
        (select count(*) from ${importJobs} where ${importJobs.workspaceId} = ${scope.workspaceId} and ${importJobs.status} in ('staging', 'queued', 'running')) +
        (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId} and ${sourceRuns.status} in ('queued', 'running')) +
        (select count(*) from ${ingestionBatches} where ${ingestionBatches.workspaceId} = ${scope.workspaceId} and ${ingestionBatches.status} in ('queued', 'running')) +
        (select count(*) from ${webhookDeliveries} where ${webhookDeliveries.workspaceId} = ${scope.workspaceId} and ${webhookDeliveries.status} in ('queued', 'running')) +
        (select count(*) from ${writebackDeliveries} where ${writebackDeliveries.workspaceId} = ${scope.workspaceId} and ${writebackDeliveries.status} in ('queued', 'running')) +
        (select count(*) from ${bulkRunBatches} where ${bulkRunBatches.workspaceId} = ${scope.workspaceId} and ${bulkRunBatches.status} in ('queued', 'running')) +
        (select count(*) from ${cellRuns} where ${cellRuns.workspaceId} = ${scope.workspaceId} and ${cellRuns.status} in ('queued', 'running')) +
        (select count(*) from ${rowSettlements} where ${rowSettlements.workspaceId} = ${scope.workspaceId} and ${rowSettlements.status} in ('queued', 'running'))
      )`,
      auditRecords: sql<number>`(
        (select count(*) from ${schemaLifecycleEvents} where ${schemaLifecycleEvents.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${connectorRevocations} where ${connectorRevocations.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${usageLedger} where ${usageLedger.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${outboxEvents} where ${outboxEvents.workspaceId} = ${scope.workspaceId})
      )`,
      cells: sql<number>`(select count(*) from ${cells} where ${cells.workspaceId} = ${scope.workspaceId})`,
      columns: sql<number>`(select count(*) from ${columns} where ${columns.workspaceId} = ${scope.workspaceId})`,
      credentials: sql<number>`(select count(*) from ${credentials} where ${credentials.workspaceId} = ${scope.workspaceId})`,
      executionRecords: sql<number>`(
        (select count(*) from ${importJobs} where ${importJobs.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${ingestionBatches} where ${ingestionBatches.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${webhookDeliveries} where ${webhookDeliveries.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${writebackDeliveries} where ${writebackDeliveries.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${bulkRunBatches} where ${bulkRunBatches.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${cellRuns} where ${cellRuns.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${rowSettlements} where ${rowSettlements.workspaceId} = ${scope.workspaceId})
      )`,
      integrations: sql<number>`(
        (select count(*) from ${sourceDefinitions} where ${sourceDefinitions.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${ingestionEndpoints} where ${ingestionEndpoints.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${webhookDestinations} where ${webhookDestinations.workspaceId} = ${scope.workspaceId}) +
        (select count(*) from ${writebackDestinations} where ${writebackDestinations.workspaceId} = ${scope.workspaceId})
      )`,
      invitations: sql<number>`(select count(*) from ${workspaceInvitations} where ${workspaceInvitations.workspaceId} = ${scope.workspaceId})`,
      members: sql<number>`(select count(*) from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${scope.workspaceId})`,
      rows: sql<number>`(select count(*) from ${rows} where ${rows.workspaceId} = ${scope.workspaceId})`,
      tables: sql<number>`(select count(*) from ${dataTables} where ${dataTables.workspaceId} = ${scope.workspaceId})`,
    })
    .from(workspaces)
    .where(eq(workspaces.id, scope.workspaceId))
    .limit(1);
  const [hold] = await db
    .select({ placedAt: workspacePurgeHolds.placedAt })
    .from(workspacePurgeHolds)
    .where(eq(workspacePurgeHolds.workspaceId, scope.workspaceId))
    .limit(1);
  if (!counts) {
    throw new SqliteWorkspacePurgeAccessError('The workspace was not found.');
  }

  const impact: WorkspacePurgeImpact = {
    auditRecords: counts.auditRecords,
    cells: counts.cells,
    columns: counts.columns,
    credentials: counts.credentials,
    executionRecords: counts.executionRecords,
    integrations: counts.integrations,
    invitations: counts.invitations,
    members: counts.members,
    rows: counts.rows,
    tables: counts.tables,
  };
  const blockers: SqliteWorkspacePurgeBlocker[] = [];
  if (counts.activeWork > 0) {
    blockers.push({
      code: 'active_work',
      count: counts.activeWork,
      message:
        'Wait for queued, staging, and running work to finish or cancel it before deleting the workspace.',
    });
  }
  if (hold) {
    blockers.push({
      code: 'legal_hold',
      count: 1,
      message:
        'An operator retention hold prevents deletion. Contact the deployment operator to review it.',
    });
  }

  const previewDigest = createHash('sha256')
    .update('byok-grid:workspace-purge-preview:v1\0')
    .update(
      JSON.stringify({
        activeWork: counts.activeWork,
        holdPlacedAt: hold?.placedAt.toISOString() ?? null,
        impact,
        workspaceId: workspace.id,
        workspaceUpdatedAt: workspace.updatedAt.toISOString(),
      })
    )
    .digest('hex');

  return {
    blockers,
    canPurge: blockers.length === 0,
    impact,
    previewDigest,
    receipt: {
      retainedFields: [
        'receiptId',
        'workspaceId',
        'actorUserId',
        'reason',
        'impact',
        'previewDigest',
        'purgedAt',
        'analyticsErasureState',
      ],
    },
    workspace: { id: workspace.id, name: workspace.name },
  };
}
