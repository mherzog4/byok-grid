import {
  partitionSqliteWorkflowRowBatch,
  queueSqliteWorkflowEnrichmentCellRuns,
  queueSqliteWorkflowWebhookDeliveries,
  selectSqliteWorkflowRowBatch,
  SqliteWorkflowRunValidationError,
  writeSqliteWorkflowRowBatch,
  type SqliteClaimedWorkflowStep,
  type SqliteClaimedWorkflowStepExecution,
  type SqliteDatabase,
} from '@byok-grid/db';
import {
  readWorkflowRowBatchOutput,
  workflowNodeSchema,
} from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { setTimeout as delay } from 'node:timers/promises';

export interface WorkflowStepResult {
  activeOutputHandles: string[];
  output: Readonly<Record<string, unknown>>;
}

export async function executeClaimedWorkflowStep(
  db: SqliteDatabase,
  claim: SqliteClaimedWorkflowStep,
  execution: SqliteClaimedWorkflowStepExecution
): Promise<WorkflowStepResult> {
  const node = workflowNodeSchema.parse({
    configuration: execution.step.configuration,
    id: execution.step.stepId,
    kind: execution.step.kind,
    name: execution.step.name,
    position: { x: 0, y: 0 },
  });

  switch (node.kind) {
    case 'trigger.table_rows': {
      const rows = await selectSqliteWorkflowRowBatch(db, {
        searchQuery: node.configuration.searchQuery,
        tableId: node.configuration.tableId,
        userId: execution.requestedByUserId,
        viewId: node.configuration.viewId,
        workspaceId: claim.workspaceId,
      });
      return {
        activeOutputHandles: rows.rows.length > 0 ? ['rows'] : [],
        output: { rows },
      };
    }
    case 'logic.filter': {
      const inbound = requireSingleInbound(execution);
      const rows = readWorkflowRowBatchOutput(
        inbound.output,
        inbound.sourceHandle
      );
      const partition = await partitionSqliteWorkflowRowBatch(db, {
        batch: rows,
        filterTree: node.configuration.filterTree,
        workspaceId: claim.workspaceId,
      });
      const connectedHandles = new Set(
        execution.step.outboundRoutes.map((route) => route.sourceHandle)
      );
      return {
        activeOutputHandles: [
          ...(partition.matched.rows.length > 0 &&
          connectedHandles.has('matched')
            ? ['matched']
            : []),
          ...(partition.rejected.rows.length > 0 &&
          connectedHandles.has('rejected')
            ? ['rejected']
            : []),
        ],
        output: partition,
      };
    }
    case 'destination.write_table': {
      const inbound = requireSingleInbound(execution);
      const rows = readWorkflowRowBatchOutput(
        inbound.output,
        inbound.sourceHandle
      );
      const written = await writeSqliteWorkflowRowBatch(db, {
        batch: rows,
        columnMappings: node.configuration.columnMappings,
        runId: claim.runId,
        stepId: claim.stepId,
        tableId: node.configuration.tableId,
        workspaceId: claim.workspaceId,
      });
      return {
        activeOutputHandles: [],
        output: {
          tableId: node.configuration.tableId,
          writtenRows: written.rows.length,
        },
      };
    }
    case 'action.enrich_column': {
      const { executeSqliteCellRun, MAXIMUM_SQLITE_CELL_RUN_RETRIES } =
        await import('./execute-cell-run');
      const inbound = requireSingleInbound(execution);
      const rows = readWorkflowRowBatchOutput(
        inbound.output,
        inbound.sourceHandle
      );
      const cellRuns = await queueSqliteWorkflowEnrichmentCellRuns(db, {
        batch: rows,
        columnId: node.configuration.columnId,
        mode: node.configuration.mode,
        runId: claim.runId,
        stepId: claim.stepId,
        workspaceId: claim.workspaceId,
      });
      for (let offset = 0; offset < cellRuns.length; offset += 5) {
        await executeConcurrentChunk(
          cellRuns.slice(offset, offset + 5),
          executeSqliteCellRun,
          MAXIMUM_SQLITE_CELL_RUN_RETRIES
        );
      }
      return {
        activeOutputHandles: rows.rows.length > 0 ? ['rows'] : [],
        output: {
          enrichedRows: cellRuns.length,
          rows,
        },
      };
    }
    case 'destination.send_webhook': {
      const { executeSqliteWebhookDelivery, MAXIMUM_WEBHOOK_RETRIES } =
        await import('./execute-webhook-delivery');
      const inbound = requireSingleInbound(execution);
      const rows = readWorkflowRowBatchOutput(
        inbound.output,
        inbound.sourceHandle
      );
      const deliveries = await queueSqliteWorkflowWebhookDeliveries(db, {
        batch: rows,
        destinationId: node.configuration.destinationId,
        runId: claim.runId,
        stepId: claim.stepId,
        workspaceId: claim.workspaceId,
      });
      for (let offset = 0; offset < deliveries.length; offset += 5) {
        await executeConcurrentChunk(
          deliveries.slice(offset, offset + 5),
          executeSqliteWebhookDelivery,
          MAXIMUM_WEBHOOK_RETRIES
        );
      }
      return {
        activeOutputHandles: [],
        output: {
          deliveredRows: deliveries.length,
          destinationId: node.configuration.destinationId,
        },
      };
    }
  }
}

async function executeConcurrentChunk<T>(
  items: readonly T[],
  execute: (item: T, retryCount: number) => Promise<unknown>,
  maximumRetries: number
): Promise<void> {
  const settled = await Promise.allSettled(
    items.map((item) => executeWithRetries(item, execute, maximumRetries))
  );
  const failed = settled.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failed) throw failed.reason;
}

async function executeWithRetries<T>(
  item: T,
  execute: (item: T, retryCount: number) => Promise<unknown>,
  maximumRetries: number
): Promise<void> {
  for (let retryCount = 0; retryCount <= maximumRetries; retryCount += 1) {
    try {
      await execute(item, retryCount);
      return;
    } catch (error) {
      if (error instanceof NonRetryableError) throw error;
      if (retryCount >= maximumRetries) throw error;
      await delay(Math.min(8_000, 500 * 2 ** retryCount));
    }
  }
}

function requireSingleInbound(
  execution: SqliteClaimedWorkflowStepExecution
): SqliteClaimedWorkflowStepExecution['inbound'][number] {
  if (execution.inbound.length !== 1) {
    throw new SqliteWorkflowRunValidationError(
      'This workflow step requires exactly one active row input.'
    );
  }
  return execution.inbound[0]!;
}
