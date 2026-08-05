import type {
  DispatchableOutboxEventType,
  SqliteClaimedOutboxEvent,
} from '@byok-grid/db';
import type { JsonObject } from '@hatchet-dev/typescript-sdk/v1';
import {
  bulkRunInputSchema,
  cellRunInputSchema,
  csvImportInputSchema,
  ingestionBatchInputSchema,
  rowSettlementInputSchema,
  sourceRunInputSchema,
  webhookDeliveryInputSchema,
  workflowRunDispatchInputSchema,
  writebackDeliveryInputSchema,
} from '@byok-grid/domain';
import {
  applySqliteCsvImport,
  MAXIMUM_CSV_IMPORT_RETRIES,
} from './apply-csv-import';
import {
  applySqliteIngestionBatch,
  MAXIMUM_INGESTION_BATCH_RETRIES,
} from './apply-ingestion-batch';
import {
  executeSqliteCellRun,
  MAXIMUM_SQLITE_CELL_RUN_RETRIES,
} from './execute-cell-run';
import {
  executeSqliteSourceRun,
  MAXIMUM_SOURCE_RUN_RETRIES,
} from './execute-source-run';
import {
  executeSqliteWebhookDelivery,
  MAXIMUM_WEBHOOK_RETRIES,
} from './execute-webhook-delivery';
import {
  executeWorkflowRun,
  MAXIMUM_WORKFLOW_RUN_RETRIES,
} from './execute-workflow-run';
import {
  executeSqliteWritebackDelivery,
  MAXIMUM_WRITEBACK_RETRIES,
} from './execute-writeback-delivery';
import {
  expandSqliteBulkRun,
  MAXIMUM_BULK_RUN_RETRIES,
} from './expand-bulk-run';
import {
  MAXIMUM_ROW_SETTLEMENT_RETRIES,
  runSqliteRowSettlement,
} from './process-row-settlement';

export interface ResolvedWorkerTask {
  execute(): Promise<unknown>;
  input: JsonObject;
  name: WorkerTaskName;
}

export type WorkerTaskName =
  | 'apply-sqlite-csv-import'
  | 'apply-sqlite-ingestion-batch'
  | 'execute-sqlite-cell-run'
  | 'execute-sqlite-source-run'
  | 'execute-sqlite-webhook-delivery'
  | 'execute-sqlite-writeback-delivery'
  | 'execute-workflow-run'
  | 'expand-sqlite-bulk-run'
  | 'process-sqlite-row-settlement';

const maximumRetriesByEventType = {
  'cell.run_requested': MAXIMUM_SQLITE_CELL_RUN_RETRIES,
  'column.bulk_run_requested': MAXIMUM_BULK_RUN_RETRIES,
  'table.csv_import_requested': MAXIMUM_CSV_IMPORT_RETRIES,
  'table.ingestion_batch_requested': MAXIMUM_INGESTION_BATCH_RETRIES,
  'table.row_settled': MAXIMUM_ROW_SETTLEMENT_RETRIES,
  'table.source_run_requested': MAXIMUM_SOURCE_RUN_RETRIES,
  'table.webhook_delivery_requested': MAXIMUM_WEBHOOK_RETRIES,
  'table.writeback_delivery_requested': MAXIMUM_WRITEBACK_RETRIES,
  'workflow.run_requested': MAXIMUM_WORKFLOW_RUN_RETRIES,
} as const satisfies Record<DispatchableOutboxEventType, number>;

export function maximumWorkerTaskRetries(
  eventType: DispatchableOutboxEventType
): number {
  return maximumRetriesByEventType[eventType];
}

export function resolveWorkerTask(
  event: Pick<SqliteClaimedOutboxEvent, 'attempt' | 'eventType' | 'payload'>
): ResolvedWorkerTask {
  const retryCount = Math.max(0, event.attempt - 1);

  switch (event.eventType) {
    case 'workflow.run_requested': {
      const input = workflowRunDispatchInputSchema.parse(event.payload);
      return {
        execute: () => executeWorkflowRun(input),
        input,
        name: 'execute-workflow-run',
      };
    }
    case 'cell.run_requested': {
      const input = cellRunInputSchema.parse(event.payload);
      return {
        execute: () => executeSqliteCellRun(input, retryCount),
        input,
        name: 'execute-sqlite-cell-run',
      };
    }
    case 'column.bulk_run_requested': {
      const input = bulkRunInputSchema.parse(event.payload);
      return {
        execute: () => expandSqliteBulkRun(input),
        input,
        name: 'expand-sqlite-bulk-run',
      };
    }
    case 'table.row_settled': {
      const input = rowSettlementInputSchema.parse(event.payload);
      return {
        execute: () => runSqliteRowSettlement(input, retryCount),
        input,
        name: 'process-sqlite-row-settlement',
      };
    }
    case 'table.csv_import_requested': {
      const input = csvImportInputSchema.parse(event.payload);
      return {
        execute: () => applySqliteCsvImport(input, retryCount),
        input,
        name: 'apply-sqlite-csv-import',
      };
    }
    case 'table.ingestion_batch_requested': {
      const input = ingestionBatchInputSchema.parse(event.payload);
      return {
        execute: () => applySqliteIngestionBatch(input, retryCount),
        input,
        name: 'apply-sqlite-ingestion-batch',
      };
    }
    case 'table.source_run_requested': {
      const input = sourceRunInputSchema.parse(event.payload);
      return {
        execute: () => executeSqliteSourceRun(input, retryCount),
        input,
        name: 'execute-sqlite-source-run',
      };
    }
    case 'table.writeback_delivery_requested': {
      const input = writebackDeliveryInputSchema.parse(event.payload);
      return {
        execute: () => executeSqliteWritebackDelivery(input, retryCount),
        input,
        name: 'execute-sqlite-writeback-delivery',
      };
    }
    case 'table.webhook_delivery_requested': {
      const input = webhookDeliveryInputSchema.parse(event.payload);
      return {
        execute: () => executeSqliteWebhookDelivery(input, retryCount),
        input,
        name: 'execute-sqlite-webhook-delivery',
      };
    }
  }
}
