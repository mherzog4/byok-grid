import {
  applyCsvImportBatch,
  CsvImportAccessError,
  CsvImportValidationError,
  prepareCsvImport,
  setCsvImportWorkerFailure,
} from '@byok-grid/db/postgres';
import { csvImportInputSchema, type CsvImportInput } from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { db } from './database';
import { hatchet } from './hatchet';

const maximumImportRetries = 2;

export const applyCsvImportTask = hatchet.task({
  name: 'apply-csv-import',
  retries: maximumImportRetries,
  backoff: { factor: 2, maxSeconds: 30 },
  executionTimeout: '30m',
  idempotency: {
    expression: 'input.importJobId',
    fallbackTtlMs: 86_400_000,
    strategy: 'status',
  },
  inputValidator: csvImportInputSchema,
  fn: (input, context) =>
    applyCsvImport(csvImportInputSchema.parse(input), context.retryCount()),
});

async function applyCsvImport(input: CsvImportInput, retryCount: number) {
  try {
    const state = await prepareCsvImport(db, input);
    if (state === 'succeeded' || state === 'cancelled') {
      return { importJobId: input.importJobId, status: state };
    }

    while (true) {
      const result = await applyCsvImportBatch(db, input);
      if (result.done) {
        return { importJobId: input.importJobId, status: 'succeeded' as const };
      }
    }
  } catch (error) {
    const nonRetryable =
      error instanceof CsvImportAccessError ||
      error instanceof CsvImportValidationError;
    const retrying = !nonRetryable && retryCount < maximumImportRetries;
    await setCsvImportWorkerFailure(db, {
      errorMessage:
        error instanceof Error ? error.message : 'The CSV import failed.',
      importJobId: input.importJobId,
      retrying,
      workspaceId: input.workspaceId,
    });
    if (nonRetryable) {
      throw new NonRetryableError(
        error instanceof Error ? error.message : 'The CSV import is invalid.'
      );
    }
    throw new Error('The CSV import failed unexpectedly.', { cause: error });
  }
}
