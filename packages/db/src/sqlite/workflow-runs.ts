import type {
  CompiledWorkflowPlan,
  CompiledWorkflowStep,
  WorkflowNodeKind,
} from '@byok-grid/domain';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import {
  workflowRuns,
  workflowStepRuns,
  workflowVersions,
  workflows,
  workspaceMembers,
  outboxEvents,
} from './schema';

export class SqliteWorkflowRunAccessError extends Error {}
export class SqliteWorkflowRunConflictError extends Error {}
export class SqliteWorkflowRunValidationError extends Error {}

export interface SqliteClaimedWorkflowStep {
  attempt: number;
  kind: WorkflowNodeKind;
  runId: string;
  stepId: string;
  workspaceId: string;
}

export interface SqliteClaimedWorkflowStepExecution {
  inbound: Array<{
    output: unknown;
    sourceHandle: string;
    sourceStepId: string;
    targetHandle: string;
  }>;
  runInput: Readonly<Record<string, unknown>>;
  requestedByUserId: string;
  step: CompiledWorkflowStep;
}

export interface SqliteWorkflowRunSummary {
  createdAt: Date;
  errorCode: string | null;
  errorMessage: string | null;
  finishedAt: Date | null;
  graphDigest: string;
  id: string;
  startedAt: Date | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  workflowId: string;
  workflowVersion: number;
  workspaceId: string;
}

export interface SqliteWorkflowRunDetails extends SqliteWorkflowRunSummary {
  steps: Array<{
    attempt: number;
    errorCode: string | null;
    errorMessage: string | null;
    finishedAt: Date | null;
    kind: WorkflowNodeKind;
    startedAt: Date | null;
    status:
      | 'blocked'
      | 'ready'
      | 'running'
      | 'succeeded'
      | 'failed'
      | 'skipped'
      | 'cancelled';
    stepId: string;
  }>;
}

interface WorkflowRunScope {
  userId: string;
  workspaceId: string;
}

export async function createSqliteWorkflowRun(
  db: SqliteDatabase,
  input: WorkflowRunScope & {
    runInput?: Readonly<Record<string, unknown>>;
    workflowId: string;
  }
): Promise<SqliteWorkflowRunSummary> {
  const runInput = parseRunInput(input.runInput ?? {});
  return withSqliteWriteTransaction(db, async (tx) => {
    const [published] = await tx
      .select({
        compiledPlan: workflowVersions.compiledPlan,
        graphDigest: workflowVersions.graphDigest,
        version: workflowVersions.version,
        workflow: workflows,
      })
      .from(workflows)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, workflows.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .innerJoin(
        workflowVersions,
        and(
          eq(workflowVersions.workflowId, workflows.id),
          eq(workflowVersions.version, workflows.publishedVersion),
          eq(workflowVersions.workspaceId, workflows.workspaceId)
        )
      )
      .where(
        and(
          eq(workflows.id, input.workflowId),
          eq(workflows.workspaceId, input.workspaceId),
          eq(workflows.state, 'active')
        )
      )
      .limit(1);
    if (!published) {
      throw new SqliteWorkflowRunAccessError(
        'The active workflow is not accessible.'
      );
    }
    if (!published.compiledPlan) {
      throw new SqliteWorkflowRunConflictError(
        'The published workflow predates executable plans and must be republished.'
      );
    }

    const [created] = await tx
      .insert(workflowRuns)
      .values({
        graphDigest: published.graphDigest,
        input: runInput,
        requestedByUserId: input.userId,
        workflowId: published.workflow.id,
        workflowVersion: published.version,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created) throw new Error('The workflow run could not be created.');

    const entries = new Set(published.compiledPlan.entryStepIds);
    await tx.insert(workflowStepRuns).values(
      published.compiledPlan.steps.map((step) => ({
        runId: created.id,
        status: entries.has(step.stepId)
          ? ('ready' as const)
          : ('blocked' as const),
        stepId: step.stepId,
        stepKind: step.kind,
        workspaceId: input.workspaceId,
      }))
    );
    await tx.insert(outboxEvents).values({
      aggregateId: created.id,
      aggregateType: 'workflow_run',
      eventType: 'workflow.run_requested',
      payload: { runId: created.id, workspaceId: input.workspaceId },
      workspaceId: input.workspaceId,
    });
    return mapRun(created);
  });
}

export async function listSqliteWorkflowRuns(
  db: SqliteDatabase,
  input: WorkflowRunScope & { limit?: number; workflowId: string }
): Promise<SqliteWorkflowRunDetails[]> {
  const [accessible] = await db
    .select({ id: workflows.id })
    .from(workflows)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, workflows.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(workflows.id, input.workflowId),
        eq(workflows.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!accessible) {
    throw new SqliteWorkflowRunAccessError(
      'The workflow run history is not accessible.'
    );
  }
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 20), 100));
  const runs = await db
    .select({ run: workflowRuns })
    .from(workflowRuns)
    .where(
      and(
        eq(workflowRuns.workflowId, input.workflowId),
        eq(workflowRuns.workspaceId, input.workspaceId)
      )
    )
    .orderBy(desc(workflowRuns.createdAt), desc(workflowRuns.id))
    .limit(limit);
  if (runs.length === 0) return [];
  const runIds = runs.map(({ run }) => run.id);
  const steps = await db
    .select({ step: workflowStepRuns })
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.workspaceId, input.workspaceId),
        inArray(workflowStepRuns.runId, runIds)
      )
    )
    .orderBy(asc(workflowStepRuns.stepId));
  const stepsByRun = new Map<string, SqliteWorkflowRunDetails['steps']>();
  for (const { step } of steps) {
    stepsByRun.set(step.runId, [
      ...(stepsByRun.get(step.runId) ?? []),
      {
        attempt: step.attempt,
        errorCode: step.errorCode,
        errorMessage: step.errorMessage,
        finishedAt: step.finishedAt,
        kind: step.stepKind,
        startedAt: step.startedAt,
        status: step.status,
        stepId: step.stepId,
      },
    ]);
  }
  return runs.map(({ run }) => ({
    ...mapRun(run),
    steps: stepsByRun.get(run.id) ?? [],
  }));
}

export async function claimSqliteWorkflowSteps(
  db: SqliteDatabase,
  input: {
    claimId: string;
    leaseSeconds?: number;
    limit?: number;
    now?: Date;
    runId?: string;
    workspaceId?: string;
  }
): Promise<SqliteClaimedWorkflowStep[]> {
  assertClaimId(input.claimId);
  if (Boolean(input.runId) !== Boolean(input.workspaceId)) {
    throw new SqliteWorkflowRunValidationError(
      'A scoped workflow claim requires both run and workspace identifiers.'
    );
  }
  const now = input.now ?? new Date();
  const leaseSeconds = Math.max(
    30,
    Math.min(Math.trunc(input.leaseSeconds ?? 300), 3_600)
  );
  const staleBefore = new Date(now.getTime() - leaseSeconds * 1_000);
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 25), 250));

  return withSqliteWriteTransaction(db, async (tx) => {
    const eligible = workflowStepEligibility(tx, now, staleBefore, input);
    const candidates = await tx
      .select({
        runId: workflowStepRuns.runId,
        stepId: workflowStepRuns.stepId,
      })
      .from(workflowStepRuns)
      .where(eligible)
      .orderBy(asc(workflowStepRuns.updatedAt), asc(workflowStepRuns.stepId))
      .limit(limit);
    if (candidates.length === 0) return [];

    const candidateScope = or(
      ...candidates.map((candidate) =>
        and(
          eq(workflowStepRuns.runId, candidate.runId),
          eq(workflowStepRuns.stepId, candidate.stepId)
        )
      )
    )!;
    const claimed = await tx
      .update(workflowStepRuns)
      .set({
        attempt: sql`${workflowStepRuns.attempt} + 1`,
        claimId: input.claimId,
        claimedAt: now,
        errorCode: null,
        errorMessage: null,
        nextAttemptAt: null,
        startedAt: sql`coalesce(${workflowStepRuns.startedAt}, ${now})`,
        status: 'running',
        updatedAt: now,
      })
      .where(and(candidateScope, eligible))
      .returning({
        attempt: workflowStepRuns.attempt,
        kind: workflowStepRuns.stepKind,
        runId: workflowStepRuns.runId,
        stepId: workflowStepRuns.stepId,
        workspaceId: workflowStepRuns.workspaceId,
      });
    if (claimed.length !== candidates.length) {
      throw new SqliteWorkflowRunConflictError(
        'The workflow step lease could not be acquired atomically.'
      );
    }
    const runIds = [...new Set(claimed.map((step) => step.runId))];
    await tx
      .update(workflowRuns)
      .set({
        startedAt: sql`coalesce(${workflowRuns.startedAt}, ${now})`,
        status: 'running',
        updatedAt: now,
      })
      .where(
        and(inArray(workflowRuns.id, runIds), eq(workflowRuns.status, 'queued'))
      );
    const order = new Map(
      candidates.map((candidate, index) => [
        `${candidate.runId}:${candidate.stepId}`,
        index,
      ])
    );
    return claimed.sort(
      (left, right) =>
        order.get(`${left.runId}:${left.stepId}`)! -
        order.get(`${right.runId}:${right.stepId}`)!
    );
  });
}

export async function getClaimedSqliteWorkflowStepExecution(
  db: SqliteDatabase,
  input: {
    claimId: string;
    runId: string;
    stepId: string;
    workspaceId: string;
  }
): Promise<SqliteClaimedWorkflowStepExecution> {
  assertClaimId(input.claimId);
  const [execution] = await db
    .select({
      plan: workflowVersions.compiledPlan,
      requestedByUserId: workflowRuns.requestedByUserId,
      runInput: workflowRuns.input,
    })
    .from(workflowStepRuns)
    .innerJoin(
      workflowRuns,
      and(
        eq(workflowRuns.id, workflowStepRuns.runId),
        eq(workflowRuns.workspaceId, workflowStepRuns.workspaceId)
      )
    )
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workflowId, workflowRuns.workflowId),
        eq(workflowVersions.version, workflowRuns.workflowVersion),
        eq(workflowVersions.workspaceId, workflowRuns.workspaceId)
      )
    )
    .where(
      and(
        eq(workflowStepRuns.runId, input.runId),
        eq(workflowStepRuns.stepId, input.stepId),
        eq(workflowStepRuns.workspaceId, input.workspaceId),
        eq(workflowStepRuns.claimId, input.claimId),
        eq(workflowStepRuns.status, 'running'),
        eq(workflowRuns.status, 'running')
      )
    )
    .limit(1);
  if (!execution?.plan) {
    throw new SqliteWorkflowRunAccessError(
      'The claimed workflow step is not active.'
    );
  }
  if (!execution.requestedByUserId) {
    throw new SqliteWorkflowRunAccessError(
      'The workflow run no longer has an authorized requesting user.'
    );
  }
  const step = requirePlanStep(execution.plan, input.stepId);
  if (step.inboundRoutes.length === 0) {
    return {
      inbound: [],
      requestedByUserId: execution.requestedByUserId,
      runInput: execution.runInput,
      step,
    };
  }

  const predecessorIds = [
    ...new Set(step.inboundRoutes.map((route) => route.sourceStepId)),
  ];
  const predecessors = await db
    .select({
      output: workflowStepRuns.output,
      status: workflowStepRuns.status,
      stepId: workflowStepRuns.stepId,
    })
    .from(workflowStepRuns)
    .where(
      and(
        eq(workflowStepRuns.runId, input.runId),
        eq(workflowStepRuns.workspaceId, input.workspaceId),
        inArray(workflowStepRuns.stepId, predecessorIds)
      )
    );
  const outputs = new Map(
    predecessors
      .filter((predecessor) => predecessor.status === 'succeeded')
      .map((predecessor) => [predecessor.stepId, predecessor.output])
  );
  const inbound = step.inboundRoutes.flatMap((route) =>
    outputs.has(route.sourceStepId)
      ? [
          {
            output: outputs.get(route.sourceStepId),
            sourceHandle: route.sourceHandle,
            sourceStepId: route.sourceStepId,
            targetHandle: route.targetHandle,
          },
        ]
      : []
  );
  if (inbound.length === 0) {
    throw new SqliteWorkflowRunConflictError(
      'The workflow step has no completed active predecessor.'
    );
  }
  return {
    inbound,
    requestedByUserId: execution.requestedByUserId,
    runInput: execution.runInput,
    step,
  };
}

export async function completeSqliteWorkflowStep(
  db: SqliteDatabase,
  input: {
    activeOutputHandles: readonly string[];
    claimId: string;
    output?: unknown;
    runId: string;
    stepId: string;
    workspaceId: string;
    now?: Date;
  }
): Promise<'running' | 'succeeded'> {
  assertClaimId(input.claimId);
  const output =
    input.output === undefined ? null : parseJsonValue(input.output, 1_048_576);
  const now = input.now ?? new Date();
  return withSqliteWriteTransaction(db, async (tx) => {
    const execution = await loadRunExecution(tx, input);
    const step = requirePlanStep(execution.plan, input.stepId);
    const allowedHandles = new Set(
      step.outboundRoutes.map((route) => route.sourceHandle)
    );
    const activeHandles = new Set(input.activeOutputHandles);
    if (
      activeHandles.size !== input.activeOutputHandles.length ||
      [...activeHandles].some((handle) => !allowedHandles.has(handle))
    ) {
      throw new SqliteWorkflowRunValidationError(
        'The workflow step selected an invalid output route.'
      );
    }

    const [completed] = await tx
      .update(workflowStepRuns)
      .set({
        claimId: null,
        claimedAt: null,
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        nextAttemptAt: null,
        output,
        status: 'succeeded',
        updatedAt: now,
      })
      .where(
        and(
          eq(workflowStepRuns.runId, input.runId),
          eq(workflowStepRuns.stepId, input.stepId),
          eq(workflowStepRuns.workspaceId, input.workspaceId),
          eq(workflowStepRuns.claimId, input.claimId),
          eq(workflowStepRuns.status, 'running')
        )
      )
      .returning({ stepId: workflowStepRuns.stepId });
    if (!completed) {
      throw new SqliteWorkflowRunConflictError(
        'The workflow step lease expired before completion.'
      );
    }

    const activeTargets = new Set(
      step.outboundRoutes
        .filter((route) => activeHandles.has(route.sourceHandle))
        .map((route) => route.targetStepId)
    );
    const inactiveTargets = step.outboundRoutes
      .filter((route) => !activeHandles.has(route.sourceHandle))
      .map((route) => route.targetStepId);
    if (activeTargets.size > 0) {
      await tx
        .update(workflowStepRuns)
        .set({ status: 'ready', updatedAt: now })
        .where(
          and(
            eq(workflowStepRuns.runId, input.runId),
            eq(workflowStepRuns.workspaceId, input.workspaceId),
            eq(workflowStepRuns.status, 'blocked'),
            inArray(workflowStepRuns.stepId, [...activeTargets])
          )
        );
    }
    const skipped = collectSkippedDescendants(
      execution.plan,
      inactiveTargets,
      activeTargets
    );
    if (skipped.size > 0) {
      await tx
        .update(workflowStepRuns)
        .set({ finishedAt: now, status: 'skipped', updatedAt: now })
        .where(
          and(
            eq(workflowStepRuns.runId, input.runId),
            eq(workflowStepRuns.workspaceId, input.workspaceId),
            eq(workflowStepRuns.status, 'blocked'),
            inArray(workflowStepRuns.stepId, [...skipped])
          )
        );
    }

    const [remaining] = await tx
      .select({ count: sql<number>`count(*)` })
      .from(workflowStepRuns)
      .where(
        and(
          eq(workflowStepRuns.runId, input.runId),
          inArray(workflowStepRuns.status, ['blocked', 'ready', 'running'])
        )
      );
    if (Number(remaining?.count ?? 0) > 0) return 'running';
    await tx
      .update(workflowRuns)
      .set({ finishedAt: now, status: 'succeeded', updatedAt: now })
      .where(
        and(
          eq(workflowRuns.id, input.runId),
          eq(workflowRuns.workspaceId, input.workspaceId),
          eq(workflowRuns.status, 'running')
        )
      );
    return 'succeeded';
  });
}

export async function retrySqliteWorkflowStep(
  db: SqliteDatabase,
  input: {
    claimId: string;
    errorCode: string;
    errorMessage: string;
    retryAt: Date;
    runId: string;
    stepId: string;
    workspaceId: string;
  }
): Promise<void> {
  assertClaimId(input.claimId);
  const [retried] = await db
    .update(workflowStepRuns)
    .set({
      claimId: null,
      claimedAt: null,
      errorCode: safeCode(input.errorCode),
      errorMessage: safeMessage(input.errorMessage),
      nextAttemptAt: input.retryAt,
      status: 'ready',
      updatedAt: new Date(),
    })
    .where(stepClaimScope(input))
    .returning({ stepId: workflowStepRuns.stepId });
  if (!retried) {
    throw new SqliteWorkflowRunConflictError(
      'The workflow step lease expired before retry scheduling.'
    );
  }
}

export async function failSqliteWorkflowStep(
  db: SqliteDatabase,
  input: {
    claimId: string;
    errorCode: string;
    errorMessage: string;
    runId: string;
    stepId: string;
    workspaceId: string;
    now?: Date;
  }
): Promise<void> {
  assertClaimId(input.claimId);
  const now = input.now ?? new Date();
  const errorCode = safeCode(input.errorCode);
  const errorMessage = safeMessage(input.errorMessage);
  await withSqliteWriteTransaction(db, async (tx) => {
    const [failed] = await tx
      .update(workflowStepRuns)
      .set({
        claimId: null,
        claimedAt: null,
        errorCode,
        errorMessage,
        finishedAt: now,
        status: 'failed',
        updatedAt: now,
      })
      .where(stepClaimScope(input))
      .returning({ stepId: workflowStepRuns.stepId });
    if (!failed) {
      throw new SqliteWorkflowRunConflictError(
        'The workflow step lease expired before failure recording.'
      );
    }
    await tx
      .update(workflowStepRuns)
      .set({
        claimId: null,
        claimedAt: null,
        finishedAt: now,
        status: 'cancelled',
        updatedAt: now,
      })
      .where(
        and(
          eq(workflowStepRuns.runId, input.runId),
          eq(workflowStepRuns.workspaceId, input.workspaceId),
          inArray(workflowStepRuns.status, ['blocked', 'ready', 'running'])
        )
      );
    await tx
      .update(workflowRuns)
      .set({
        errorCode,
        errorMessage,
        finishedAt: now,
        status: 'failed',
        updatedAt: now,
      })
      .where(
        and(
          eq(workflowRuns.id, input.runId),
          eq(workflowRuns.workspaceId, input.workspaceId),
          inArray(workflowRuns.status, ['queued', 'running'])
        )
      );
  });
}

function workflowStepEligibility(
  db: Pick<SqliteDatabase, 'select'>,
  now: Date,
  staleBefore: Date,
  scope: { runId?: string; workspaceId?: string }
) {
  return and(
    scope.runId ? eq(workflowStepRuns.runId, scope.runId) : undefined,
    scope.workspaceId
      ? eq(workflowStepRuns.workspaceId, scope.workspaceId)
      : undefined,
    or(
      and(
        eq(workflowStepRuns.status, 'ready'),
        or(
          isNull(workflowStepRuns.nextAttemptAt),
          lte(workflowStepRuns.nextAttemptAt, now)
        )
      ),
      and(
        eq(workflowStepRuns.status, 'running'),
        lt(workflowStepRuns.claimedAt, staleBefore)
      )
    ),
    exists(
      db
        .select({ value: sql`1` })
        .from(workflowRuns)
        .where(
          and(
            eq(workflowRuns.id, workflowStepRuns.runId),
            inArray(workflowRuns.status, ['queued', 'running'])
          )
        )
    )
  )!;
}

async function loadRunExecution(
  db: Pick<SqliteDatabase, 'select'>,
  scope: { runId: string; workspaceId: string }
): Promise<{ plan: CompiledWorkflowPlan }> {
  const [execution] = await db
    .select({ plan: workflowVersions.compiledPlan })
    .from(workflowRuns)
    .innerJoin(
      workflowVersions,
      and(
        eq(workflowVersions.workflowId, workflowRuns.workflowId),
        eq(workflowVersions.version, workflowRuns.workflowVersion),
        eq(workflowVersions.workspaceId, workflowRuns.workspaceId)
      )
    )
    .where(
      and(
        eq(workflowRuns.id, scope.runId),
        eq(workflowRuns.workspaceId, scope.workspaceId),
        eq(workflowRuns.status, 'running')
      )
    )
    .limit(1);
  if (!execution?.plan) {
    throw new SqliteWorkflowRunAccessError('The workflow run is not active.');
  }
  return { plan: execution.plan };
}

function requirePlanStep(
  plan: CompiledWorkflowPlan,
  stepId: string
): CompiledWorkflowStep {
  const step = plan.steps.find((candidate) => candidate.stepId === stepId);
  if (!step) {
    throw new SqliteWorkflowRunValidationError(
      'The workflow step is not part of the published plan.'
    );
  }
  return step;
}

function collectSkippedDescendants(
  plan: CompiledWorkflowPlan,
  initialStepIds: readonly string[],
  protectedStepIds: ReadonlySet<string>
): Set<string> {
  const skipped = new Set<string>();
  const pending = [...initialStepIds];
  while (pending.length > 0) {
    const stepId = pending.shift()!;
    if (skipped.has(stepId) || protectedStepIds.has(stepId)) continue;
    skipped.add(stepId);
    const step = requirePlanStep(plan, stepId);
    pending.push(...step.outboundRoutes.map((route) => route.targetStepId));
  }
  return skipped;
}

function stepClaimScope(input: {
  claimId: string;
  runId: string;
  stepId: string;
  workspaceId: string;
}) {
  return and(
    eq(workflowStepRuns.runId, input.runId),
    eq(workflowStepRuns.stepId, input.stepId),
    eq(workflowStepRuns.workspaceId, input.workspaceId),
    eq(workflowStepRuns.claimId, input.claimId),
    eq(workflowStepRuns.status, 'running')
  );
}

function assertClaimId(claimId: string): void {
  if (!claimId || claimId.length > 200 || /\p{Cc}/u.test(claimId)) {
    throw new SqliteWorkflowRunValidationError(
      'The workflow step claim identifier is invalid.'
    );
  }
}

function parseJsonValue<T>(value: T, maximumBytes: number): T {
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new SqliteWorkflowRunValidationError(
      'Workflow run data must be valid JSON.'
    );
  }
  if (json === undefined || Buffer.byteLength(json, 'utf8') > maximumBytes) {
    throw new SqliteWorkflowRunValidationError(
      'Workflow run data exceeds the storage limit.'
    );
  }
  return JSON.parse(json) as T;
}

function parseRunInput(
  value: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new SqliteWorkflowRunValidationError(
      'Workflow run input must be a JSON object.'
    );
  }
  return parseJsonValue(value, 64 * 1_024);
}

function safeCode(value: string): string {
  const code = value.trim().slice(0, 120);
  if (!code || !/^[A-Za-z0-9_.-]+$/.test(code)) {
    throw new SqliteWorkflowRunValidationError(
      'The workflow error code is invalid.'
    );
  }
  return code;
}

function safeMessage(value: string): string {
  const message = value
    .replace(/[\r\n\t]/g, ' ')
    .trim()
    .slice(0, 500);
  if (!message) {
    throw new SqliteWorkflowRunValidationError(
      'The workflow error message is invalid.'
    );
  }
  return message;
}

function mapRun(
  run: typeof workflowRuns.$inferSelect
): SqliteWorkflowRunSummary {
  return {
    createdAt: run.createdAt,
    errorCode: run.errorCode,
    errorMessage: run.errorMessage,
    finishedAt: run.finishedAt,
    graphDigest: run.graphDigest,
    id: run.id,
    startedAt: run.startedAt,
    status: run.status,
    workflowId: run.workflowId,
    workflowVersion: run.workflowVersion,
    workspaceId: run.workspaceId,
  };
}
