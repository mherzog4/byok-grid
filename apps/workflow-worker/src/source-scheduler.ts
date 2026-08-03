import { queueDueSqliteSourceRuns } from '@byok-grid/db';
import { setTimeout as delay } from 'node:timers/promises';
import { workflowWorkerConfig } from './config';
import { workflowDb } from './database';

export async function scheduleSqliteSources(
  signal: AbortSignal
): Promise<void> {
  while (!signal.aborted) {
    try {
      await queueDueSqliteSourceRuns(workflowDb);
      await delay(
        workflowWorkerConfig.SOURCE_SCHEDULER_POLL_SECONDS * 1_000,
        undefined,
        { signal }
      );
    } catch (error) {
      if (signal.aborted) return;
      console.error('SQLite source scheduling failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      await delay(2_000, undefined, { signal }).catch(() => undefined);
    }
  }
}
