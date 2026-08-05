import {
  processSqliteRowSettlement,
  setSqliteRowSettlementWorkerFailure,
} from '@byok-grid/db';
import type { RowSettlementInput } from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { z } from 'zod';
import { workflowWorkerConfig } from './config';
import { workflowDb } from './database';

export const MAXIMUM_ROW_SETTLEMENT_RETRIES = 2;

export async function runSqliteRowSettlement(
  input: RowSettlementInput,
  retryCount: number
) {
  try {
    return await processSqliteRowSettlement(workflowDb, input, {
      maximumAutomaticRuns:
        workflowWorkerConfig.AUTOMATIC_RUN_MAX_PER_ROW_CHANGE,
      maximumAutomaticWritebacks:
        workflowWorkerConfig.AUTOMATIC_WRITEBACK_MAX_PER_ROW_CHANGE,
    });
  } catch (error) {
    const retrying =
      !(error instanceof z.ZodError) &&
      retryCount < MAXIMUM_ROW_SETTLEMENT_RETRIES;
    const message =
      error instanceof z.ZodError
        ? 'The settled row is too large or invalid for automatic delivery.'
        : error instanceof Error
          ? error.message
          : 'The settled row could not be processed.';
    await setSqliteRowSettlementWorkerFailure(workflowDb, {
      ...input,
      errorMessage: message,
      retrying,
    });
    if (!retrying) throw new NonRetryableError(message);
    throw new Error(message, { cause: error });
  }
}
