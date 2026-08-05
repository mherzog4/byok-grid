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
import { workflowHatchet } from './hatchet';
import {
  MAXIMUM_ROW_SETTLEMENT_RETRIES,
  runSqliteRowSettlement,
} from './process-row-settlement';

const applySqliteCsvImportTask = workflowHatchet.task({
  name: 'apply-sqlite-csv-import',
  retries: MAXIMUM_CSV_IMPORT_RETRIES,
  backoff: { factor: 2, maxSeconds: 30 },
  executionTimeout: '30m',
  idempotency: idempotency('input.importJobId'),
  inputValidator: csvImportInputSchema,
  fn: (input, context) =>
    applySqliteCsvImport(
      csvImportInputSchema.parse(input),
      context.retryCount()
    ),
});

const applySqliteIngestionBatchTask = workflowHatchet.task({
  name: 'apply-sqlite-ingestion-batch',
  retries: MAXIMUM_INGESTION_BATCH_RETRIES,
  backoff: { factor: 2, maxSeconds: 30 },
  executionTimeout: '30m',
  idempotency: idempotency('input.batchId'),
  inputValidator: ingestionBatchInputSchema,
  fn: (input, context) =>
    applySqliteIngestionBatch(
      ingestionBatchInputSchema.parse(input),
      context.retryCount()
    ),
});

const expandSqliteBulkRunTask = workflowHatchet.task({
  name: 'expand-sqlite-bulk-run',
  retries: MAXIMUM_BULK_RUN_RETRIES,
  backoff: { factor: 2, maxSeconds: 60 },
  idempotency: idempotency('input.batchId'),
  inputValidator: bulkRunInputSchema,
  fn: (input) => expandSqliteBulkRun(bulkRunInputSchema.parse(input)),
});

const executeSqliteCellRunTask = workflowHatchet.task({
  name: 'execute-sqlite-cell-run',
  retries: MAXIMUM_SQLITE_CELL_RUN_RETRIES,
  backoff: { factor: 2, maxSeconds: 60 },
  executionTimeout: '2m',
  idempotency: idempotency('input.runId'),
  inputValidator: cellRunInputSchema,
  fn: (input, context) =>
    executeSqliteCellRun(cellRunInputSchema.parse(input), context.retryCount()),
});

const executeSqliteSourceRunTask = workflowHatchet.task({
  name: 'execute-sqlite-source-run',
  retries: MAXIMUM_SOURCE_RUN_RETRIES,
  backoff: { factor: 2, maxSeconds: 60 },
  executionTimeout: '30m',
  idempotency: idempotency('input.sourceRunId'),
  inputValidator: sourceRunInputSchema,
  fn: (input, context) =>
    executeSqliteSourceRun(
      sourceRunInputSchema.parse(input),
      context.retryCount()
    ),
});

const executeSqliteWebhookDeliveryTask = workflowHatchet.task({
  name: 'execute-sqlite-webhook-delivery',
  retries: MAXIMUM_WEBHOOK_RETRIES,
  backoff: { factor: 2, maxSeconds: 300 },
  executionTimeout: '2m',
  idempotency: idempotency('input.deliveryId', 7 * 86_400_000),
  inputValidator: webhookDeliveryInputSchema,
  fn: (input, context) =>
    executeSqliteWebhookDelivery(
      webhookDeliveryInputSchema.parse(input),
      context.retryCount()
    ),
});

const executeSqliteWritebackDeliveryTask = workflowHatchet.task({
  name: 'execute-sqlite-writeback-delivery',
  retries: MAXIMUM_WRITEBACK_RETRIES,
  backoff: { factor: 2, maxSeconds: 300 },
  executionTimeout: '2m',
  idempotency: idempotency('input.deliveryId', 7 * 86_400_000),
  inputValidator: writebackDeliveryInputSchema,
  fn: (input, context) =>
    executeSqliteWritebackDelivery(
      writebackDeliveryInputSchema.parse(input),
      context.retryCount()
    ),
});

const executeWorkflowRunTask = workflowHatchet.task({
  name: 'execute-workflow-run',
  retries: MAXIMUM_WORKFLOW_RUN_RETRIES,
  backoff: { factor: 2, maxSeconds: 30 },
  executionTimeout: '30m',
  idempotency: idempotency('input.runId'),
  inputValidator: workflowRunDispatchInputSchema,
  fn: (input) =>
    executeWorkflowRun(workflowRunDispatchInputSchema.parse(input)),
});

const processSqliteRowSettlementTask = workflowHatchet.task({
  name: 'process-sqlite-row-settlement',
  retries: MAXIMUM_ROW_SETTLEMENT_RETRIES,
  backoff: { factor: 2, maxSeconds: 30 },
  idempotency: idempotency('input.settlementId', 7 * 86_400_000),
  inputValidator: rowSettlementInputSchema,
  fn: (input, context) =>
    runSqliteRowSettlement(
      rowSettlementInputSchema.parse(input),
      context.retryCount()
    ),
});

export const hatchetTasks = [
  applySqliteCsvImportTask,
  applySqliteIngestionBatchTask,
  expandSqliteBulkRunTask,
  executeWorkflowRunTask,
  executeSqliteCellRunTask,
  executeSqliteSourceRunTask,
  executeSqliteWebhookDeliveryTask,
  executeSqliteWritebackDeliveryTask,
  processSqliteRowSettlementTask,
];

function idempotency(expression: string, fallbackTtlMs = 86_400_000) {
  return {
    expression,
    fallbackTtlMs,
    strategy: 'status' as const,
  };
}
