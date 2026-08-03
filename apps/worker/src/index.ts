import { applyCsvImportTask } from './apply-csv-import';
import { applyIngestionBatchTask } from './apply-ingestion-batch';
import { expandBulkRunTask } from './expand-bulk-run';
import { executeCellRunTask } from './execute-cell-run';
import { executeSourceRunTask } from './execute-source-run';
import { executeWebhookDeliveryTask } from './execute-webhook-delivery';
import { executeWritebackDeliveryTask } from './execute-writeback-delivery';
import { processRowSettlementTask } from './process-row-settlement';
import { egressDispatcher } from './egress';
import { hatchet } from './hatchet';
import { dispatchOutbox } from './outbox-dispatcher';
import { scheduleSources } from './source-scheduler';

const worker = await hatchet.worker('byok-grid-worker', {
  slots: 25,
  workflows: [
    applyCsvImportTask,
    applyIngestionBatchTask,
    executeCellRunTask,
    executeSourceRunTask,
    executeWebhookDeliveryTask,
    executeWritebackDeliveryTask,
    expandBulkRunTask,
    processRowSettlementTask,
  ],
});

const dispatcherController = new AbortController();
const dispatcher = dispatchOutbox(dispatcherController.signal);
const sourceScheduler = scheduleSources(dispatcherController.signal);

try {
  await worker.start();
} finally {
  dispatcherController.abort();
  await Promise.all([dispatcher, sourceScheduler]);
  await egressDispatcher.close();
}
