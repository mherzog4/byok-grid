import { expandSqliteBulkRunBatchChunk } from '@byok-grid/db';
import { bulkRunInputSchema } from '@byok-grid/domain';
import { workflowWorkerConfig } from './config';
import { workflowDb } from './database';
import { workflowHatchet } from './hatchet';

export const expandSqliteBulkRunTask = workflowHatchet.task({
  name: 'expand-sqlite-bulk-run',
  retries: 4,
  backoff: { factor: 2, maxSeconds: 60 },
  idempotency: {
    expression: 'input.batchId',
    fallbackTtlMs: 86_400_000,
    strategy: 'status',
  },
  inputValidator: bulkRunInputSchema,
  fn: async (rawInput) => {
    const input = bulkRunInputSchema.parse(rawInput);
    for (;;) {
      const result = await expandSqliteBulkRunBatchChunk(
        workflowDb,
        input,
        workflowWorkerConfig.BULK_RUN_EXPANSION_CHUNK_SIZE
      );
      if (result.status !== 'running') return result;
    }
  },
});
