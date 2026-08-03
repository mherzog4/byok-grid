import {
  processRowSettlement,
  setRowSettlementWorkerFailure,
} from '@byok-grid/db/postgres';
import {
  rowSettlementInputSchema,
  type RowSettlementInput,
} from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { z } from 'zod';
import { config } from './config';
import { db } from './database';
import { hatchet } from './hatchet';

const maximumRetries = 2;

export const processRowSettlementTask = hatchet.task({
  name: 'process-row-settlement',
  retries: maximumRetries,
  backoff: { factor: 2, maxSeconds: 30 },
  idempotency: {
    expression: 'input.settlementId',
    fallbackTtlMs: 7 * 86_400_000,
    strategy: 'status',
  },
  inputValidator: rowSettlementInputSchema,
  fn: (input, context) =>
    runRowSettlement(
      rowSettlementInputSchema.parse(input),
      context.retryCount()
    ),
});

async function runRowSettlement(input: RowSettlementInput, retryCount: number) {
  try {
    return await processRowSettlement(db, input, {
      maximumAutomaticRuns: config.AUTOMATIC_RUN_MAX_PER_ROW_CHANGE,
      maximumAutomaticWritebacks: config.AUTOMATIC_WRITEBACK_MAX_PER_ROW_CHANGE,
    });
  } catch (error) {
    const retrying =
      !(error instanceof z.ZodError) && retryCount < maximumRetries;
    const message =
      error instanceof z.ZodError
        ? 'The settled row is too large or invalid for automatic delivery.'
        : error instanceof Error
          ? error.message
          : 'The settled row could not be processed.';
    await setRowSettlementWorkerFailure(db, {
      ...input,
      errorMessage: message,
      retrying,
    });
    if (!retrying) throw new NonRetryableError(message);
    throw new Error(message, { cause: error });
  }
}
