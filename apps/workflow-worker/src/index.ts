import { workflowDatabase } from './database';
import { applySqliteIngestionBatchTask } from './apply-ingestion-batch';
import { applySqliteCsvImportTask } from './apply-csv-import';
import { dispatchWorkflowRuns } from './dispatcher';
import { expandSqliteBulkRunTask } from './expand-bulk-run';
import { executeSqliteCellRunTask } from './execute-cell-run';
import { executeSqliteSourceRunTask } from './execute-source-run';
import { executeWorkflowRunTask } from './execute-workflow-run';
import { executeSqliteWebhookDeliveryTask } from './execute-webhook-delivery';
import { executeSqliteWritebackDeliveryTask } from './execute-writeback-delivery';
import { workflowHatchet } from './hatchet';
import { processSqliteRowSettlementTask } from './process-row-settlement';
import { scheduleSqliteSources } from './source-scheduler';

const worker = await workflowHatchet.worker('byok-grid-workflow-worker', {
  slots: 10,
  workflows: [
    applySqliteCsvImportTask,
    applySqliteIngestionBatchTask,
    expandSqliteBulkRunTask,
    executeWorkflowRunTask,
    executeSqliteCellRunTask,
    executeSqliteSourceRunTask,
    executeSqliteWebhookDeliveryTask,
    executeSqliteWritebackDeliveryTask,
    processSqliteRowSettlementTask,
  ],
});
const dispatcherController = new AbortController();
const dispatcher = dispatchWorkflowRuns(dispatcherController.signal);
const sourceScheduler = scheduleSqliteSources(dispatcherController.signal);

try {
  await worker.start();
} finally {
  dispatcherController.abort();
  await Promise.all([dispatcher, sourceScheduler]);
  workflowDatabase.close();
}
