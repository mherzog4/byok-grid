import { collectSqliteOperationalMetrics } from '@byok-grid/db';
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
import { workflowWorkerConfig } from './config';
import { createOperationalMetricsTask } from './operational-metrics';
import { processSqliteRowSettlementTask } from './process-row-settlement';
import { scheduleSqliteSources } from './source-scheduler';
import { runWorkerLifecycle } from './worker-lifecycle';

const worker = await workflowHatchet.worker('byok-grid-workflow-worker', {
  handleKill: false,
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
await runWorkerLifecycle({
  backgroundTasks: [
    { name: 'workflow dispatcher', run: dispatchWorkflowRuns },
    { name: 'source scheduler', run: scheduleSqliteSources },
    ...(workflowWorkerConfig.BYOK_GRID_METRICS_ENABLED === 'true'
      ? [
          createOperationalMetricsTask({
            collect: () =>
              collectSqliteOperationalMetrics(workflowDatabase.client),
            port: workflowWorkerConfig.BYOK_GRID_METRICS_PORT,
          }),
        ]
      : []),
  ],
  closeDatabase: () => workflowDatabase.close(),
  signalSource: process,
  worker,
});
