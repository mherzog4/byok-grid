import { expandBulkRunBatchChunk } from '@byok-grid/db/postgres';
import { bulkRunInputSchema } from '@byok-grid/domain';
import { config } from './config';
import { db } from './database';
import { hatchet } from './hatchet';

export const expandBulkRunTask = hatchet.task({
  name: 'expand-bulk-run',
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
    while (true) {
      const result = await expandBulkRunBatchChunk(
        db,
        input,
        config.BULK_RUN_EXPANSION_CHUNK_SIZE
      );
      if (result.status !== 'running') return result;
    }
  },
});
