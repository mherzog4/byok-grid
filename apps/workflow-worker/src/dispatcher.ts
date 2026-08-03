import {
  claimSqliteOutboxEvents,
  completeSqliteOutboxEvent,
  DISPATCHABLE_OUTBOX_EVENT_TYPES,
  retrySqliteOutboxEvent,
} from '@byok-grid/db';
import {
  bulkRunInputSchema,
  cellRunInputSchema,
  csvImportInputSchema,
  ingestionBatchInputSchema,
  rowSettlementInputSchema,
  sourceRunInputSchema,
  webhookDeliveryInputSchema,
  writebackDeliveryInputSchema,
  workflowRunDispatchInputSchema,
} from '@byok-grid/domain';
import { IdempotencyCollisionError } from '@hatchet-dev/typescript-sdk/v1';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { workflowWorkerConfig } from './config';
import { workflowDb } from './database';
import { workflowHatchet } from './hatchet';

export async function dispatchWorkflowRuns(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const count = await dispatchBatch();
      if (count === 0) {
        await delay(workflowWorkerConfig.WORKFLOW_DISPATCH_POLL_MS, undefined, {
          signal,
        });
      }
    } catch (error) {
      if (signal.aborted) return;
      console.error('Workflow outbox dispatch failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      await delay(2_000, undefined, { signal }).catch(() => undefined);
    }
  }
}

async function dispatchBatch(): Promise<number> {
  const claimId = randomUUID();
  const events = await claimSqliteOutboxEvents(workflowDb, {
    claimId,
    eventTypes: DISPATCHABLE_OUTBOX_EVENT_TYPES,
    limit: 10,
  });
  for (const event of events) {
    try {
      const dispatch =
        event.eventType === 'workflow.run_requested'
          ? {
              input: workflowRunDispatchInputSchema.parse(event.payload),
              task: 'execute-workflow-run',
            }
          : event.eventType === 'cell.run_requested'
            ? {
                input: cellRunInputSchema.parse(event.payload),
                task: 'execute-sqlite-cell-run',
              }
            : event.eventType === 'column.bulk_run_requested'
              ? {
                  input: bulkRunInputSchema.parse(event.payload),
                  task: 'expand-sqlite-bulk-run',
                }
              : event.eventType === 'table.row_settled'
                ? {
                    input: rowSettlementInputSchema.parse(event.payload),
                    task: 'process-sqlite-row-settlement',
                  }
                : event.eventType === 'table.csv_import_requested'
                  ? {
                      input: csvImportInputSchema.parse(event.payload),
                      task: 'apply-sqlite-csv-import',
                    }
                  : event.eventType === 'table.ingestion_batch_requested'
                    ? {
                        input: ingestionBatchInputSchema.parse(event.payload),
                        task: 'apply-sqlite-ingestion-batch',
                      }
                    : event.eventType === 'table.source_run_requested'
                      ? {
                          input: sourceRunInputSchema.parse(event.payload),
                          task: 'execute-sqlite-source-run',
                        }
                      : event.eventType === 'table.writeback_delivery_requested'
                        ? {
                            input: writebackDeliveryInputSchema.parse(
                              event.payload
                            ),
                            task: 'execute-sqlite-writeback-delivery',
                          }
                        : {
                            input: webhookDeliveryInputSchema.parse(
                              event.payload
                            ),
                            task: 'execute-sqlite-webhook-delivery',
                          };
      try {
        await workflowHatchet.runNoWait(dispatch.task, dispatch.input);
      } catch (error) {
        if (!(error instanceof IdempotencyCollisionError)) throw error;
      }
      await completeSqliteOutboxEvent(workflowDb, {
        claimId,
        eventId: event.id,
      });
    } catch (error) {
      await retrySqliteOutboxEvent(workflowDb, {
        claimId,
        errorMessage:
          error instanceof Error ? `${error.name}: ${error.message}` : 'Error',
        eventId: event.id,
        retryAt: new Date(Date.now() + Math.min(60_000, event.attempt * 5_000)),
      });
    }
  }
  return events.length;
}
