import { createHash, randomUUID } from 'node:crypto';
import {
  compileWorkflowGraph,
  workflowDefinitionRequestSchema,
  workflowDraftUpdateRequestSchema,
  workflowGraphSchema,
  type WorkflowDraftGraph,
  type WorkflowGraph,
} from '@byok-grid/domain';
import { and, desc, eq, sql } from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import { workflowVersions, workflows, workspaceMembers } from './schema';

export class SqliteWorkflowAccessError extends Error {}
export class SqliteWorkflowConflictError extends Error {}

export interface SqliteWorkflowSummary {
  createdAt: Date;
  draftDigest: string;
  draftGraph: WorkflowDraftGraph;
  draftRevision: number;
  id: string;
  name: string;
  publishedVersion: number | null;
  state: 'active' | 'draft' | 'paused';
  updatedAt: Date;
  workspaceId: string;
}

interface WorkflowScope {
  userId: string;
  workspaceId: string;
}

export async function createSqliteWorkflow(
  db: SqliteDatabase,
  input: WorkflowScope & { graph: unknown; name: string }
): Promise<SqliteWorkflowSummary> {
  const definition = workflowDefinitionRequestSchema.parse({
    graph: input.graph,
    name: input.name,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireWorkspaceMembership(tx, input);
    const now = new Date();
    const id = randomUUID();
    const draftDigest = digestWorkflowGraph(definition.graph);
    const [created] = await tx
      .insert(workflows)
      .values({
        createdAt: now,
        createdByUserId: input.userId,
        draftDigest,
        draftGraph: definition.graph,
        id,
        name: definition.name,
        updatedAt: now,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created) throw new Error('The workflow was not created.');
    return mapWorkflow(created);
  });
}

export async function listSqliteWorkflows(
  db: SqliteDatabase,
  scope: WorkflowScope
): Promise<SqliteWorkflowSummary[]> {
  const records = await db
    .select({ workflow: workflows })
    .from(workflows)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workflows.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(eq(workflows.workspaceId, scope.workspaceId))
    .orderBy(desc(workflows.updatedAt), workflows.id);
  return records.map(({ workflow }) => mapWorkflow(workflow));
}

export async function getSqliteWorkflow(
  db: SqliteDatabase,
  scope: WorkflowScope & { workflowId: string }
): Promise<SqliteWorkflowSummary> {
  const record = await selectScopedWorkflow(db, scope);
  if (!record) throw new SqliteWorkflowAccessError('Workflow not found.');
  return mapWorkflow(record);
}

export async function updateSqliteWorkflowDraft(
  db: SqliteDatabase,
  input: WorkflowScope & {
    expectedRevision: number;
    graph: unknown;
    name: string;
    workflowId: string;
  }
): Promise<SqliteWorkflowSummary> {
  const draft = workflowDraftUpdateRequestSchema.parse({
    expectedRevision: input.expectedRevision,
    graph: input.graph,
    name: input.name,
  });
  const [updated] = await db
    .update(workflows)
    .set({
      draftDigest: digestWorkflowGraph(draft.graph),
      draftGraph: draft.graph,
      draftRevision: sql`${workflows.draftRevision} + 1`,
      name: draft.name,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workflows.id, input.workflowId),
        eq(workflows.workspaceId, input.workspaceId),
        eq(workflows.draftRevision, draft.expectedRevision),
        workspaceMembershipExists(input)
      )
    )
    .returning();
  if (updated) return mapWorkflow(updated);

  const accessible = await selectScopedWorkflow(db, input);
  if (!accessible) throw new SqliteWorkflowAccessError('Workflow not found.');
  throw new SqliteWorkflowConflictError(
    'The workflow changed elsewhere. Reload the latest draft.'
  );
}

export async function publishSqliteWorkflow(
  db: SqliteDatabase,
  input: WorkflowScope & { expectedRevision: number; workflowId: string }
): Promise<SqliteWorkflowSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const current = await selectScopedWorkflow(tx, input);
    if (!current) throw new SqliteWorkflowAccessError('Workflow not found.');
    if (current.draftRevision !== input.expectedRevision) {
      throw new SqliteWorkflowConflictError(
        'The workflow changed elsewhere. Reload before publishing.'
      );
    }

    const graph = workflowGraphSchema.parse(current.draftGraph);
    const compiledPlan = compileWorkflowGraph(graph);
    const nextVersion = (current.publishedVersion ?? 0) + 1;
    const publishedAt = new Date();
    await tx.insert(workflowVersions).values({
      compiledPlan,
      createdByUserId: input.userId,
      graph,
      graphDigest: current.draftDigest,
      id: randomUUID(),
      publishedAt,
      version: nextVersion,
      workflowId: current.id,
      workspaceId: input.workspaceId,
    });
    const [published] = await tx
      .update(workflows)
      .set({
        publishedVersion: nextVersion,
        state: 'active',
        updatedAt: publishedAt,
      })
      .where(
        and(
          eq(workflows.id, input.workflowId),
          eq(workflows.workspaceId, input.workspaceId),
          eq(workflows.draftRevision, input.expectedRevision),
          workspaceMembershipExists(input)
        )
      )
      .returning();
    if (!published) {
      throw new SqliteWorkflowConflictError(
        'The workflow changed while it was being published.'
      );
    }
    return mapWorkflow(published);
  });
}

function digestWorkflowGraph(graph: WorkflowDraftGraph): string {
  return createHash('sha256')
    .update(canonicalJson(graph), 'utf8')
    .digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
    return `{${fields.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function workspaceMembershipExists(scope: WorkflowScope) {
  return sql`exists (
    select 1 from ${workspaceMembers}
    where ${workspaceMembers.workspaceId} = ${workflows.workspaceId}
      and ${workspaceMembers.userId} = ${scope.userId}
  )`;
}

async function requireWorkspaceMembership(
  db: Pick<SqliteDatabase, 'select'>,
  scope: WorkflowScope
) {
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, scope.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .limit(1);
  if (!membership) throw new SqliteWorkflowAccessError('Workspace not found.');
  return membership;
}

async function selectScopedWorkflow(
  db: Pick<SqliteDatabase, 'select'>,
  scope: WorkflowScope & { workflowId: string }
) {
  const [record] = await db
    .select({ workflow: workflows })
    .from(workflows)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workflows.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(
      and(
        eq(workflows.id, scope.workflowId),
        eq(workflows.workspaceId, scope.workspaceId)
      )
    )
    .limit(1);
  return record?.workflow;
}

function mapWorkflow(
  record: typeof workflows.$inferSelect
): SqliteWorkflowSummary {
  return {
    createdAt: record.createdAt,
    draftDigest: record.draftDigest,
    draftGraph: workflowDefinitionRequestSchema.shape.graph.parse(
      record.draftGraph
    ),
    draftRevision: record.draftRevision,
    id: record.id,
    name: record.name,
    publishedVersion: record.publishedVersion,
    state: record.state,
    updatedAt: record.updatedAt,
    workspaceId: record.workspaceId,
  };
}
