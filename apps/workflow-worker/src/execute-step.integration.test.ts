import {
  claimSqliteWorkflowSteps,
  completeSqliteWorkflowStep,
  createSqliteGridRow,
  createSqliteWorkflow,
  createSqliteWorkflowRun,
  createSqliteWorkspaceTable,
  getClaimedSqliteWorkflowStepExecution,
  migrateSqliteDatabase,
  openSqliteDatabase,
  publishSqliteWorkflow,
  selectSqliteWorkflowRowBatch,
  writeSqliteGridCell,
  type SqliteClaimedWorkflowStep,
  type SqliteDatabaseHandle,
} from '@byok-grid/db';
import { workflowRuns } from '@byok-grid/db/sqlite/schema';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeClaimedWorkflowStep } from './execute-step';

const userId = '00000000-0000-4000-8000-000000000401';
const workspaceId = '00000000-0000-4000-8000-000000000402';

describe('SQLite visual workflow step execution', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `byok-grid-workflow-worker-${randomUUID()}.sqlite`
    );
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.client.executeMultiple(`
      insert into users (id, email, name)
        values ('${userId}', 'workflow-worker@example.test', 'Worker Owner');
      insert into workspaces (id, name, slug)
        values ('${workspaceId}', 'Workflow Worker', 'workflow-worker');
      insert into workspace_members (workspace_id, user_id, role)
        values ('${workspaceId}', '${userId}', 'owner');
    `);
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('runs trigger → filter → write table against one authoritative ledger', async () => {
    const source = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Company',
      firstColumnValueType: 'text',
      name: 'Prospects',
      userId,
      workspaceId,
    });
    const target = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Company',
      firstColumnValueType: 'text',
      name: 'Qualified',
      userId,
      workspaceId,
    });
    const [acme, globex] = await Promise.all([
      createSqliteGridRow(handle.db, {
        tableId: source.id,
        userId,
        workspaceId,
      }),
      createSqliteGridRow(handle.db, {
        tableId: source.id,
        userId,
        workspaceId,
      }),
    ]);
    await Promise.all([
      writeSqliteGridCell(handle.db, {
        columnId: source.firstColumn.id,
        expectedVersion: 0,
        rowId: acme.id,
        tableId: source.id,
        userId,
        value: { type: 'text', value: 'Acme Labs' },
        workspaceId,
      }),
      writeSqliteGridCell(handle.db, {
        columnId: source.firstColumn.id,
        expectedVersion: 0,
        rowId: globex.id,
        tableId: source.id,
        userId,
        value: { type: 'text', value: 'Globex' },
        workspaceId,
      }),
    ]);

    const triggerId = randomUUID();
    const filterId = randomUUID();
    const destinationId = randomUUID();
    const workflow = await createSqliteWorkflow(handle.db, {
      graph: {
        edges: [
          {
            id: randomUUID(),
            sourceHandle: 'rows',
            sourceNodeId: triggerId,
            targetHandle: 'rows',
            targetNodeId: filterId,
          },
          {
            id: randomUUID(),
            sourceHandle: 'matched',
            sourceNodeId: filterId,
            targetHandle: 'rows',
            targetNodeId: destinationId,
          },
        ],
        nodes: [
          {
            configuration: {
              searchQuery: null,
              tableId: source.id,
              viewId: null,
            },
            id: triggerId,
            kind: 'trigger.table_rows',
            name: 'All prospects',
            position: { x: 0, y: 0 },
          },
          {
            configuration: {
              filterTree: {
                children: [
                  {
                    columnId: source.firstColumn.id,
                    operator: 'text_contains',
                    value: 'acme',
                  },
                ],
                combinator: 'and',
              },
            },
            id: filterId,
            kind: 'logic.filter',
            name: 'Only Acme',
            position: { x: 300, y: 0 },
          },
          {
            configuration: {
              columnMappings: [
                {
                  sourceColumnId: source.firstColumn.id,
                  targetColumnId: target.firstColumn.id,
                },
              ],
              tableId: target.id,
            },
            id: destinationId,
            kind: 'destination.write_table',
            name: 'Write qualified',
            position: { x: 600, y: 0 },
          },
        ],
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      name: 'Qualify Acme',
      userId,
      workspaceId,
    });
    await publishSqliteWorkflow(handle.db, {
      expectedRevision: workflow.draftRevision,
      userId,
      workflowId: workflow.id,
      workspaceId,
    });
    const run = await createSqliteWorkflowRun(handle.db, {
      userId,
      workflowId: workflow.id,
      workspaceId,
    });

    for (const expectedStepId of [triggerId, filterId, destinationId]) {
      const claimId = randomUUID();
      const [claim] = await claimSqliteWorkflowSteps(handle.db, {
        claimId,
        limit: 1,
        runId: run.id,
        workspaceId,
      });
      expect(claim?.stepId).toBe(expectedStepId);
      await executeAndComplete(claim!, claimId);
    }

    const [storedRun] = await handle.db
      .select({ status: workflowRuns.status })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, run.id));
    expect(storedRun?.status).toBe('succeeded');
    const copied = await selectSqliteWorkflowRowBatch(handle.db, {
      searchQuery: null,
      tableId: target.id,
      userId,
      viewId: null,
      workspaceId,
    });
    expect(copied.rows).toHaveLength(1);
    expect(
      await selectSqliteWorkflowRowBatch(handle.db, {
        searchQuery: 'Acme',
        tableId: target.id,
        userId,
        viewId: null,
        workspaceId,
      })
    ).toMatchObject({
      rows: [expect.objectContaining({ tableId: target.id })],
    });

    async function executeAndComplete(
      claim: SqliteClaimedWorkflowStep,
      claimId: string
    ) {
      const execution = await getClaimedSqliteWorkflowStepExecution(handle.db, {
        claimId,
        runId: claim.runId,
        stepId: claim.stepId,
        workspaceId: claim.workspaceId,
      });
      const result = await executeClaimedWorkflowStep(
        handle.db,
        claim,
        execution
      );
      await completeSqliteWorkflowStep(handle.db, {
        activeOutputHandles: result.activeOutputHandles,
        claimId,
        output: result.output,
        runId: claim.runId,
        stepId: claim.stepId,
        workspaceId: claim.workspaceId,
      });
    }
  });
});
