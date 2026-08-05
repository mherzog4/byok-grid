import {
  claimSqliteOutboxEvents,
  completeSqliteOutboxEvent,
  DISPATCHABLE_OUTBOX_EVENT_TYPES,
  retrySqliteOutboxEvent,
} from '@byok-grid/db';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { workflowWorkerConfig } from './config';
import { workflowDb } from './database';
import { maximumWorkerTaskRetries, resolveWorkerTask } from './task-handlers';

export async function dispatchLocalWorkflowTasks(
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    try {
      const count = await executeLocalBatch();
      if (count === 0) {
        await delay(workflowWorkerConfig.WORKFLOW_DISPATCH_POLL_MS, undefined, {
          signal,
        });
      }
    } catch (error) {
      if (signal.aborted) return;
      console.error('Local workflow dispatch failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      await delay(2_000, undefined, { signal }).catch(() => undefined);
    }
  }
}

async function executeLocalBatch(): Promise<number> {
  const claimId = randomUUID();
  const events = await claimSqliteOutboxEvents(workflowDb, {
    claimId,
    eventTypes: DISPATCHABLE_OUTBOX_EVENT_TYPES,
    limit: 10,
  });

  for (const event of events) {
    try {
      await resolveWorkerTask(event).execute();
      await completeSqliteOutboxEvent(workflowDb, {
        claimId,
        eventId: event.id,
      });
    } catch (error) {
      if (
        error instanceof NonRetryableError ||
        event.attempt - 1 >= maximumWorkerTaskRetries(event.eventType)
      ) {
        console.error('Local workflow task reached a terminal failure', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
          eventType: event.eventType,
        });
        await completeSqliteOutboxEvent(workflowDb, {
          claimId,
          eventId: event.id,
        });
        continue;
      }
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
