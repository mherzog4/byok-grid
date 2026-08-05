import {
  applySqliteIngestionBatchChunk,
  markSqliteIngestionBatchRunning,
  setSqliteIngestionBatchWorkerFailure,
  SqliteIngestionAccessError,
  SqliteIngestionConflictError,
  SqliteIngestionValidationError,
} from '@byok-grid/db';
import type { IngestionBatchInput } from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { setTimeout as delay } from 'node:timers/promises';
import { workflowDb } from './database';

export const MAXIMUM_INGESTION_BATCH_RETRIES = 2;

export async function applySqliteIngestionBatch(
  input: IngestionBatchInput,
  retryCount: number
) {
  try {
    let state = await markSqliteIngestionBatchRunning(workflowDb, input);
    while (state === 'waiting') {
      await delay(1_000);
      state = await markSqliteIngestionBatchRunning(workflowDb, input);
    }
    if (state !== 'ready') return { batchId: input.batchId, status: state };
    for (;;) {
      const result = await applySqliteIngestionBatchChunk(workflowDb, input);
      if (result.done) {
        return { batchId: input.batchId, status: result.summary.status };
      }
    }
  } catch (error) {
    const nonRetryable =
      error instanceof SqliteIngestionAccessError ||
      error instanceof SqliteIngestionConflictError ||
      error instanceof SqliteIngestionValidationError;
    const retrying =
      !nonRetryable && retryCount < MAXIMUM_INGESTION_BATCH_RETRIES;
    await setSqliteIngestionBatchWorkerFailure(workflowDb, {
      ...input,
      errorMessage:
        error instanceof Error ? error.message : 'The ingestion batch failed.',
      retrying,
    });
    if (nonRetryable || !retrying) {
      throw new NonRetryableError(
        error instanceof Error
          ? error.message
          : 'The ingestion batch is invalid.'
      );
    }
    throw new Error('The ingestion batch failed unexpectedly.', {
      cause: error,
    });
  }
}
