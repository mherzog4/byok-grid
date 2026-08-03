import {
  applySqliteIngestionBatchChunk,
  markSqliteIngestionBatchRunning,
  setSqliteIngestionBatchWorkerFailure,
  SqliteIngestionAccessError,
  SqliteIngestionConflictError,
  SqliteIngestionValidationError,
} from '@byok-grid/db';
import {
  ingestionBatchInputSchema,
  type IngestionBatchInput,
} from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { setTimeout as delay } from 'node:timers/promises';
import { workflowDb } from './database';
import { workflowHatchet } from './hatchet';

const maximumRetries = 2;

export const applySqliteIngestionBatchTask = workflowHatchet.task({
  name: 'apply-sqlite-ingestion-batch',
  retries: maximumRetries,
  backoff: { factor: 2, maxSeconds: 30 },
  executionTimeout: '30m',
  idempotency: {
    expression: 'input.batchId',
    fallbackTtlMs: 86_400_000,
    strategy: 'status',
  },
  inputValidator: ingestionBatchInputSchema,
  fn: (input, context) =>
    applySqliteIngestionBatch(
      ingestionBatchInputSchema.parse(input),
      context.retryCount()
    ),
});

async function applySqliteIngestionBatch(
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
    const retrying = !nonRetryable && retryCount < maximumRetries;
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
