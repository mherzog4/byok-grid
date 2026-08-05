import {
  collectSqliteOperationalMetrics,
  sqliteWriteContentionSnapshot,
} from '@byok-grid/db';
import { workflowWorkerConfig } from './config';
import { workflowDatabase } from './database';
import { dispatchLocalWorkflowTasks } from './local-dispatcher';
import { createOperationalMetricsTask } from './operational-metrics';
import { scheduleSqliteSources } from './source-scheduler';
import { runWorkerLifecycle } from './worker-lifecycle';

export async function runLocalWorker(): Promise<void> {
  const idleWorker = createIdleWorker();
  await runWorkerLifecycle({
    backgroundTasks: [
      { name: 'local workflow dispatcher', run: dispatchLocalWorkflowTasks },
      { name: 'source scheduler', run: scheduleSqliteSources },
      ...(workflowWorkerConfig.BYOK_GRID_METRICS_ENABLED === 'true'
        ? [
            createOperationalMetricsTask({
              collect: () =>
                collectSqliteOperationalMetrics(workflowDatabase.client),
              collectContention: sqliteWriteContentionSnapshot,
              port: workflowWorkerConfig.BYOK_GRID_METRICS_PORT,
            }),
          ]
        : []),
    ],
    closeDatabase: () => workflowDatabase.close(),
    signalSource: process,
    worker: idleWorker,
  });
  console.log(
    JSON.stringify({ marker: 'BYOK_GRID_LOCAL_WORKER_DRAIN_COMPLETE' })
  );
}

function createIdleWorker() {
  let resolveStop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  return {
    start: () => stopped,
    stop: async () => resolveStop(),
  };
}
