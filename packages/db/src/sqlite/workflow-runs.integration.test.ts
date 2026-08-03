import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  createSqliteWorkflowRun,
  claimSqliteWorkflowSteps,
  completeSqliteWorkflowStep,
  failSqliteWorkflowStep,
  getClaimedSqliteWorkflowStepExecution,
  retrySqliteWorkflowStep,
  SqliteWorkflowRunConflictError,
} from './workflow-runs';
import { outboxEvents, workflowRuns, workflowStepRuns } from './schema';
import { createSqliteWorkflow, publishSqliteWorkflow } from './workflows';

const userId = '00000000-0000-4000-8000-000000000001';
const workspaceId = '00000000-0000-4000-8000-000000000002';
const triggerId = '00000000-0000-4000-8000-000000000011';
const filterId = '00000000-0000-4000-8000-000000000012';
const matchedId = '00000000-0000-4000-8000-000000000013';
const rejectedId = '00000000-0000-4000-8000-000000000014';
const start = new Date('2030-01-01T12:00:00.000Z');

describe('SQLite workflow run engine', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let workflowId: string;

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `byok-grid-workflow-runs-${randomUUID()}.sqlite`
    );
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.client.executeMultiple(`
      insert into users (id, email, name)
        values ('${userId}', 'workflow-runs@example.test', 'Run Owner');
      insert into workspaces (id, name, slug)
        values ('${workspaceId}', 'Workflow Runs', 'workflow-runs');
      insert into workspace_members (workspace_id, user_id, role)
        values ('${workspaceId}', '${userId}', 'owner');
    `);
    const workflow = await createSqliteWorkflow(handle.db, {
      graph: branchingGraph(),
      name: 'Branching workflow',
      userId,
      workspaceId,
    });
    workflowId = workflow.id;
    await publishSqliteWorkflow(handle.db, {
      expectedRevision: workflow.draftRevision,
      userId,
      workflowId,
      workspaceId,
    });
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('leases steps once, honors retry delay, and skips an inactive branch', async () => {
    const run = await createSqliteWorkflowRun(handle.db, {
      runInput: { requestedFrom: 'editor' },
      userId,
      workflowId,
      workspaceId,
    });
    expect(run).toMatchObject({ status: 'queued', workflowVersion: 1 });
    const [dispatch] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, run.id));
    expect(dispatch).toMatchObject({
      aggregateType: 'workflow_run',
      eventType: 'workflow.run_requested',
      payload: { runId: run.id, workspaceId },
      publishedAt: null,
    });

    const [left, right] = await Promise.all([
      claimSqliteWorkflowSteps(handle.db, {
        claimId: 'worker-left',
        limit: 1,
        now: start,
      }),
      claimSqliteWorkflowSteps(handle.db, {
        claimId: 'worker-right',
        limit: 1,
        now: start,
      }),
    ]);
    const [trigger] = [...left, ...right];
    expect([...left, ...right]).toHaveLength(1);
    expect(trigger).toMatchObject({ attempt: 1, stepId: triggerId });
    const triggerClaimId = left.length === 1 ? 'worker-left' : 'worker-right';
    expect(
      await getClaimedSqliteWorkflowStepExecution(handle.db, {
        claimId: triggerClaimId,
        runId: run.id,
        stepId: triggerId,
        workspaceId,
      })
    ).toMatchObject({
      inbound: [],
      requestedByUserId: userId,
      runInput: { requestedFrom: 'editor' },
      step: { kind: 'trigger.table_rows', stepId: triggerId },
    });
    await expect(
      completeSqliteWorkflowStep(handle.db, {
        activeOutputHandles: ['rows'],
        claimId: 'stale-worker',
        runId: run.id,
        stepId: triggerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWorkflowRunConflictError);
    expect(
      await completeSqliteWorkflowStep(handle.db, {
        activeOutputHandles: ['rows'],
        claimId: triggerClaimId,
        output: { selectedRows: 4 },
        runId: run.id,
        stepId: triggerId,
        workspaceId,
        now: start,
      })
    ).toBe('running');

    const [filter] = await claimSqliteWorkflowSteps(handle.db, {
      claimId: 'filter-worker',
      now: start,
      runId: run.id,
      workspaceId,
    });
    expect(filter).toMatchObject({ attempt: 1, stepId: filterId });
    expect(
      await getClaimedSqliteWorkflowStepExecution(handle.db, {
        claimId: 'filter-worker',
        runId: run.id,
        stepId: filterId,
        workspaceId,
      })
    ).toMatchObject({
      inbound: [
        {
          output: { selectedRows: 4 },
          sourceHandle: 'rows',
          sourceStepId: triggerId,
          targetHandle: 'rows',
        },
      ],
      step: { kind: 'logic.filter', stepId: filterId },
    });
    const retryAt = new Date(start.getTime() + 60_000);
    await retrySqliteWorkflowStep(handle.db, {
      claimId: 'filter-worker',
      errorCode: 'temporary_failure',
      errorMessage: 'Temporary\nfilter failure',
      retryAt,
      runId: run.id,
      stepId: filterId,
      workspaceId,
    });
    expect(
      await claimSqliteWorkflowSteps(handle.db, {
        claimId: 'early-worker',
        now: new Date(retryAt.getTime() - 1),
      })
    ).toEqual([]);
    expect(
      await claimSqliteWorkflowSteps(handle.db, {
        claimId: 'filter-retry-worker',
        now: retryAt,
      })
    ).toEqual([expect.objectContaining({ attempt: 2, stepId: filterId })]);
    await completeSqliteWorkflowStep(handle.db, {
      activeOutputHandles: ['matched'],
      claimId: 'filter-retry-worker',
      output: { matchedRows: 3, rejectedRows: 1 },
      runId: run.id,
      stepId: filterId,
      workspaceId,
      now: retryAt,
    });

    const [destination] = await claimSqliteWorkflowSteps(handle.db, {
      claimId: 'destination-worker',
      now: retryAt,
    });
    expect(destination).toMatchObject({ stepId: matchedId });
    expect(
      await completeSqliteWorkflowStep(handle.db, {
        activeOutputHandles: [],
        claimId: 'destination-worker',
        output: { deliveries: 3 },
        runId: run.id,
        stepId: matchedId,
        workspaceId,
        now: retryAt,
      })
    ).toBe('succeeded');

    const steps = await handle.db
      .select({
        attempt: workflowStepRuns.attempt,
        status: workflowStepRuns.status,
        stepId: workflowStepRuns.stepId,
      })
      .from(workflowStepRuns)
      .where(eq(workflowStepRuns.runId, run.id));
    expect(new Map(steps.map((step) => [step.stepId, step]))).toMatchObject(
      new Map([
        [triggerId, { attempt: 1, status: 'succeeded', stepId: triggerId }],
        [filterId, { attempt: 2, status: 'succeeded', stepId: filterId }],
        [matchedId, { attempt: 1, status: 'succeeded', stepId: matchedId }],
        [rejectedId, { attempt: 0, status: 'skipped', stepId: rejectedId }],
      ])
    );
    const [storedRun] = await handle.db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, run.id));
    expect(storedRun).toMatchObject({ status: 'succeeded' });
  });

  it('recovers stale leases and fails the run with sibling cancellation', async () => {
    const run = await createSqliteWorkflowRun(handle.db, {
      userId,
      workflowId,
      workspaceId,
    });
    await claimSqliteWorkflowSteps(handle.db, {
      claimId: 'crashed-worker',
      leaseSeconds: 30,
      now: start,
    });
    expect(
      await claimSqliteWorkflowSteps(handle.db, {
        claimId: 'early-recovery',
        leaseSeconds: 30,
        now: new Date(start.getTime() + 30_000),
      })
    ).toEqual([]);
    expect(
      await claimSqliteWorkflowSteps(handle.db, {
        claimId: 'recovery-worker',
        leaseSeconds: 30,
        now: new Date(start.getTime() + 30_001),
      })
    ).toEqual([expect.objectContaining({ attempt: 2, stepId: triggerId })]);

    await failSqliteWorkflowStep(handle.db, {
      claimId: 'recovery-worker',
      errorCode: 'connector_failed',
      errorMessage: 'Provider\nrejected the request',
      now: new Date(start.getTime() + 31_000),
      runId: run.id,
      stepId: triggerId,
      workspaceId,
    });
    const [storedRun, steps] = await Promise.all([
      handle.db
        .select()
        .from(workflowRuns)
        .where(eq(workflowRuns.id, run.id))
        .then((records) => records[0]),
      handle.db
        .select()
        .from(workflowStepRuns)
        .where(
          and(
            eq(workflowStepRuns.runId, run.id),
            eq(workflowStepRuns.workspaceId, workspaceId)
          )
        ),
    ]);
    expect(storedRun).toMatchObject({
      errorCode: 'connector_failed',
      errorMessage: 'Provider rejected the request',
      status: 'failed',
    });
    expect(steps.find((step) => step.stepId === triggerId)?.status).toBe(
      'failed'
    );
    expect(
      steps
        .filter((step) => step.stepId !== triggerId)
        .every((step) => step.status === 'cancelled')
    ).toBe(true);
  });
});

function branchingGraph() {
  return {
    edges: [
      {
        id: '00000000-0000-4000-8000-000000000101',
        sourceHandle: 'rows',
        sourceNodeId: triggerId,
        targetHandle: 'rows',
        targetNodeId: filterId,
      },
      {
        id: '00000000-0000-4000-8000-000000000102',
        sourceHandle: 'matched',
        sourceNodeId: filterId,
        targetHandle: 'rows',
        targetNodeId: matchedId,
      },
      {
        id: '00000000-0000-4000-8000-000000000103',
        sourceHandle: 'rejected',
        sourceNodeId: filterId,
        targetHandle: 'rows',
        targetNodeId: rejectedId,
      },
    ],
    nodes: [
      {
        configuration: {
          searchQuery: null,
          tableId: '00000000-0000-4000-8000-000000000201',
          viewId: null,
        },
        id: triggerId,
        kind: 'trigger.table_rows',
        name: 'Rows',
        position: { x: 0, y: 0 },
      },
      {
        configuration: {
          filterTree: { children: [], combinator: 'and' },
        },
        id: filterId,
        kind: 'logic.filter',
        name: 'Qualified?',
        position: { x: 300, y: 0 },
      },
      {
        configuration: {
          destinationId: '00000000-0000-4000-8000-000000000202',
        },
        id: matchedId,
        kind: 'destination.send_webhook',
        name: 'Send matched',
        position: { x: 600, y: -150 },
      },
      {
        configuration: {
          destinationId: '00000000-0000-4000-8000-000000000203',
        },
        id: rejectedId,
        kind: 'destination.send_webhook',
        name: 'Send rejected',
        position: { x: 600, y: 150 },
      },
    ],
    schemaVersion: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}
