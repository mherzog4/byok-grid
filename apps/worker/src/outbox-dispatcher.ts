import {
  claimOutboxEvents,
  completeOutboxEvent,
  retryOutboxEvent,
} from '@byok-grid/db/postgres';
import {
  bulkRunInputSchema,
  cellRunInputSchema,
  csvImportInputSchema,
  ingestionBatchInputSchema,
  rowSettlementInputSchema,
  sourceRunInputSchema,
  webhookDeliveryInputSchema,
  writebackDeliveryInputSchema,
} from '@byok-grid/domain';
import { IdempotencyCollisionError } from '@hatchet-dev/typescript-sdk/v1';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { db } from './database';
import { hatchet } from './hatchet';
import { outboxRetryDelayMs } from './outbox-retry';

export async function dispatchOutbox(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const count = await dispatchBatch();
      if (count === 0) await delay(1_000, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      console.error('Outbox dispatch failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      await delay(2_000, undefined, { signal }).catch(() => undefined);
    }
  }
}

async function dispatchBatch(): Promise<number> {
  const claimId = randomUUID();
  const events = await claimOutboxEvents(db, { claimId, limit: 10 });
  for (const event of events) {
    try {
      const workflow = resolveWorkflow(event.eventType, event.payload);
      try {
        await hatchet.runNoWait(workflow.name, workflow.input);
      } catch (error) {
        if (!(error instanceof IdempotencyCollisionError)) throw error;
      }
      await completeOutboxEvent(db, { claimId, eventId: event.id });
    } catch (error) {
      await retryOutboxEvent(db, {
        claimId,
        errorMessage:
          error instanceof Error ? `${error.name}: ${error.message}` : 'Error',
        eventId: event.id,
        retryAt: new Date(Date.now() + outboxRetryDelayMs(event.attempt)),
      });
    }
  }
  return events.length;
}

function resolveWorkflow(
  eventType: string,
  payload: Readonly<Record<string, unknown>>
) {
  if (eventType === 'cell.run_requested') {
    return {
      input: cellRunInputSchema.parse(payload),
      name: 'execute-cell-run',
    };
  }
  if (eventType === 'column.bulk_run_requested') {
    return {
      input: bulkRunInputSchema.parse(payload),
      name: 'expand-bulk-run',
    };
  }
  if (eventType === 'table.csv_import_requested') {
    return {
      input: csvImportInputSchema.parse(payload),
      name: 'apply-csv-import',
    };
  }
  if (eventType === 'table.ingestion_batch_requested') {
    return {
      input: ingestionBatchInputSchema.parse(payload),
      name: 'apply-ingestion-batch',
    };
  }
  if (eventType === 'table.webhook_delivery_requested') {
    return {
      input: webhookDeliveryInputSchema.parse(payload),
      name: 'execute-webhook-delivery',
    };
  }
  if (eventType === 'table.writeback_delivery_requested') {
    return {
      input: writebackDeliveryInputSchema.parse(payload),
      name: 'execute-writeback-delivery',
    };
  }
  if (eventType === 'table.row_settled') {
    return {
      input: rowSettlementInputSchema.parse(payload),
      name: 'process-row-settlement',
    };
  }
  return {
    input: sourceRunInputSchema.parse(payload),
    name: 'execute-source-run',
  };
}
