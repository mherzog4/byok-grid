import { expandSqliteBulkRunBatchChunk } from '@byok-grid/db';
import type { BulkRunInput } from '@byok-grid/domain';
import { workflowWorkerConfig } from './config';
import { workflowDb } from './database';

export const MAXIMUM_BULK_RUN_RETRIES = 4;

export async function expandSqliteBulkRun(input: BulkRunInput) {
  for (;;) {
    const result = await expandSqliteBulkRunBatchChunk(
      workflowDb,
      input,
      workflowWorkerConfig.BULK_RUN_EXPANSION_CHUNK_SIZE
    );
    if (result.status !== 'running') return result;
  }
}
