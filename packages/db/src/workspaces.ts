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
import type { Database } from './client';
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
  savedGridViews,
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
} from './schema';

export class WorkspacePurgeAccessError extends Error {}
export class WorkspacePurgeConflictError extends Error {}
export class WorkspacePurgeValidationError extends Error {}

export interface WorkspacePurgeBlocker {
  code: 'active_work' | 'legal_hold';
  count: number;
  message: string;
}

export interface WorkspacePurgePreview {
  blockers: WorkspacePurgeBlocker[];
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

export interface WorkspacePurgeReceipt {
  actorUserId: string | null;
  id: string;
  impact: WorkspacePurgeImpact;
  purgedAt: Date;
  reason: WorkspacePurgeReason;
  workspaceId: string;
}

interface WorkspaceScope {
  userId: string;
  workspaceId: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: 'owner' | 'admin' | 'member';
  slug: string;
}

export async function listUserWorkspaces(
  db: Database,
  userId: string
): Promise<WorkspaceSummary[]> {
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

export async function ensurePersonalWorkspace(
  db: Database,
  user: Readonly<{ id: string; name: string }>
): Promise<WorkspaceSummary> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${user.id}, 0))`
    );

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
      workspaceId: workspace.id,
      userId: user.id,
      role: 'owner',
    });

    const [starterTable] = await tx
      .insert(dataTables)
      .values({ workspaceId: workspace.id, name: 'Companies' })
      .returning({ id: dataTables.id });

    if (!starterTable) {
      throw new Error('The starter table could not be created.');
    }

    await tx.insert(columns).values([
      {
        workspaceId: workspace.id,
        tableId: starterTable.id,
        name: 'Company',
        kind: 'input',
        valueType: 'text',
        position: 'a0',
      },
      {
        workspaceId: workspace.id,
        tableId: starterTable.id,
        name: 'Domain',
        kind: 'input',
        valueType: 'text',
        position: 'a1',
      },
    ]);

    return { ...workspace, role: 'owner' };
  });
}

export async function previewWorkspacePurge(
  db: Database,
  scope: WorkspaceScope
): Promise<WorkspacePurgePreview> {
  return db.transaction((tx) =>
    buildWorkspacePurgePreview(tx as unknown as Database, scope)
  );
}

export async function purgeWorkspace(
  db: Database,
  input: WorkspaceScope & WorkspacePurgeRequest
): Promise<WorkspacePurgeReceipt> {
  const parsed = workspacePurgeRequestSchema.safeParse({
    acknowledgeIrreversible: input.acknowledgeIrreversible,
    confirmationName: input.confirmationName,
    previewDigest: input.previewDigest,
    reason: input.reason,
  });
  if (!parsed.success) {
    throw new WorkspacePurgeValidationError(
      parsed.error.issues[0]?.message ?? 'The purge confirmation is invalid.'
    );
  }

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`workspace-purge:${input.workspaceId}`}, 0))`
    );
    const preview = await buildWorkspacePurgePreview(
      tx as unknown as Database,
      input
    );
    if (
      !workspacePurgeConfirmationMatches(
        preview.workspace.name,
        parsed.data.confirmationName
      )
    ) {
      throw new WorkspacePurgeValidationError(
        'Type the exact workspace name to confirm permanent deletion.'
      );
    }
    if (preview.previewDigest !== parsed.data.previewDigest) {
      throw new WorkspacePurgeConflictError(
        'The workspace changed after the preview. Review the refreshed impact before trying again.'
      );
    }
    if (preview.blockers.length > 0) {
      throw new WorkspacePurgeConflictError(preview.blockers[0]!.message);
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
      throw new WorkspacePurgeAccessError(
        'The workspace could not be permanently deleted.'
      );
    }
    return receipt;
  });
}

async function buildWorkspacePurgePreview(
  db: Database,
  scope: WorkspaceScope
): Promise<WorkspacePurgePreview> {
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
    .limit(1)
    .for('update', { of: workspaces });
  if (
    !workspace ||
    !hasWorkspacePermission(workspace.role, 'workspace.manage')
  ) {
    throw new WorkspacePurgeAccessError('The workspace was not found.');
  }

  const [counts, hold] = await Promise.all([
    db
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
        )::int`,
        auditRecords: sql<number>`(
          (select count(*) from ${schemaLifecycleEvents} where ${schemaLifecycleEvents.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${connectorRevocations} where ${connectorRevocations.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${usageLedger} where ${usageLedger.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${outboxEvents} where ${outboxEvents.workspaceId} = ${scope.workspaceId})
        )::int`,
        cells: sql<number>`(select count(*)::int from ${cells} where ${cells.workspaceId} = ${scope.workspaceId})`,
        columns: sql<number>`(select count(*)::int from ${columns} where ${columns.workspaceId} = ${scope.workspaceId})`,
        credentials: sql<number>`(select count(*)::int from ${credentials} where ${credentials.workspaceId} = ${scope.workspaceId})`,
        executionRecords: sql<number>`(
          (select count(*) from ${importJobs} where ${importJobs.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${ingestionBatches} where ${ingestionBatches.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${webhookDeliveries} where ${webhookDeliveries.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${writebackDeliveries} where ${writebackDeliveries.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${bulkRunBatches} where ${bulkRunBatches.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${cellRuns} where ${cellRuns.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${rowSettlements} where ${rowSettlements.workspaceId} = ${scope.workspaceId})
        )::int`,
        integrations: sql<number>`(
          (select count(*) from ${sourceDefinitions} where ${sourceDefinitions.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${ingestionEndpoints} where ${ingestionEndpoints.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${webhookDestinations} where ${webhookDestinations.workspaceId} = ${scope.workspaceId}) +
          (select count(*) from ${writebackDestinations} where ${writebackDestinations.workspaceId} = ${scope.workspaceId})
        )::int`,
        invitations: sql<number>`(select count(*)::int from ${workspaceInvitations} where ${workspaceInvitations.workspaceId} = ${scope.workspaceId})`,
        members: sql<number>`(select count(*)::int from ${workspaceMembers} where ${workspaceMembers.workspaceId} = ${scope.workspaceId})`,
        rows: sql<number>`(select count(*)::int from ${rows} where ${rows.workspaceId} = ${scope.workspaceId})`,
        tables: sql<number>`(select count(*)::int from ${dataTables} where ${dataTables.workspaceId} = ${scope.workspaceId})`,
      })
      .from(workspaces)
      .where(eq(workspaces.id, scope.workspaceId))
      .limit(1)
      .then((items) => items[0]),
    db
      .select({ placedAt: workspacePurgeHolds.placedAt })
      .from(workspacePurgeHolds)
      .where(eq(workspacePurgeHolds.workspaceId, scope.workspaceId))
      .limit(1)
      .then((items) => items[0]),
  ]);
  if (!counts) {
    throw new WorkspacePurgeAccessError('The workspace was not found.');
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
  const blockers: WorkspacePurgeBlocker[] = [];
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
