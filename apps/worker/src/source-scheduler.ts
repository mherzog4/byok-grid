import { queueDueSourceRuns } from '@byok-grid/db/postgres';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config';
import { db } from './database';

export async function scheduleSources(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      await queueDueSourceRuns(db);
      await delay(config.SOURCE_SCHEDULER_POLL_SECONDS * 1_000, undefined, {
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      console.error('Source scheduling failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      await delay(2_000, undefined, { signal }).catch(() => undefined);
    }
  }
}
