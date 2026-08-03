import {
  applyIngestionBatchChunk,
  IngestionAccessError,
  IngestionConflictError,
  IngestionValidationError,
  markIngestionBatchRunning,
  setIngestionBatchWorkerFailure,
} from '@byok-grid/db/postgres';
import {
  ingestionBatchInputSchema,
  type IngestionBatchInput,
} from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { setTimeout as delay } from 'node:timers/promises';
import { db } from './database';
import { hatchet } from './hatchet';

const maximumRetries = 2;

export const applyIngestionBatchTask = hatchet.task({
  name: 'apply-ingestion-batch',
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
    applyIngestionBatch(
      ingestionBatchInputSchema.parse(input),
      context.retryCount()
    ),
});

async function applyIngestionBatch(
  input: IngestionBatchInput,
  retryCount: number
) {
  try {
    let state = await markIngestionBatchRunning(db, input);
    while (state === 'waiting') {
      await delay(1_000);
      state = await markIngestionBatchRunning(db, input);
    }
    if (state !== 'ready') return { batchId: input.batchId, status: state };
    for (;;) {
      const result = await applyIngestionBatchChunk(db, input);
      if (result.done) {
        return { batchId: input.batchId, status: result.summary.status };
      }
    }
  } catch (error) {
    const nonRetryable =
      error instanceof IngestionAccessError ||
      error instanceof IngestionConflictError ||
      error instanceof IngestionValidationError;
    const retrying = !nonRetryable && retryCount < maximumRetries;
    await setIngestionBatchWorkerFailure(db, {
      batchId: input.batchId,
      errorMessage:
        error instanceof Error ? error.message : 'The ingestion batch failed.',
      retrying,
      workspaceId: input.workspaceId,
    });
    if (nonRetryable) {
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
