import {
  applySqliteCsvImportBatch,
  prepareSqliteCsvImport,
  setSqliteCsvImportWorkerFailure,
  SqliteCsvImportAccessError,
  SqliteCsvImportValidationError,
} from '@byok-grid/db';
import type { CsvImportInput } from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { workflowDb } from './database';

export const MAXIMUM_CSV_IMPORT_RETRIES = 2;

export async function applySqliteCsvImport(
  input: CsvImportInput,
  retryCount: number
) {
  try {
    const state = await prepareSqliteCsvImport(workflowDb, input);
    if (state === 'succeeded' || state === 'cancelled') {
      return { importJobId: input.importJobId, status: state };
    }
    for (;;) {
      const result = await applySqliteCsvImportBatch(workflowDb, input);
      if (result.done) {
        return { importJobId: input.importJobId, status: 'succeeded' as const };
      }
    }
  } catch (error) {
    const nonRetryable =
      error instanceof SqliteCsvImportAccessError ||
      error instanceof SqliteCsvImportValidationError;
    const retrying = !nonRetryable && retryCount < MAXIMUM_CSV_IMPORT_RETRIES;
    await setSqliteCsvImportWorkerFailure(workflowDb, {
      errorMessage:
        error instanceof Error ? error.message : 'The CSV import failed.',
      importJobId: input.importJobId,
      retrying,
      workspaceId: input.workspaceId,
    });
    if (nonRetryable || !retrying) {
      throw new NonRetryableError(
        error instanceof Error ? error.message : 'The CSV import is invalid.'
      );
    }
    throw new Error('The CSV import failed unexpectedly.', { cause: error });
  }
}
