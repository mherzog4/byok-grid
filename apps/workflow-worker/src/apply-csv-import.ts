import {
  applySqliteCsvImportBatch,
  prepareSqliteCsvImport,
  setSqliteCsvImportWorkerFailure,
  SqliteCsvImportAccessError,
  SqliteCsvImportValidationError,
} from '@byok-grid/db';
import { csvImportInputSchema, type CsvImportInput } from '@byok-grid/domain';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { workflowDb } from './database';
import { workflowHatchet } from './hatchet';

const maximumImportRetries = 2;

export const applySqliteCsvImportTask = workflowHatchet.task({
  name: 'apply-sqlite-csv-import',
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
    applySqliteCsvImport(
      csvImportInputSchema.parse(input),
      context.retryCount()
    ),
});

async function applySqliteCsvImport(input: CsvImportInput, retryCount: number) {
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
    const retrying = !nonRetryable && retryCount < maximumImportRetries;
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
