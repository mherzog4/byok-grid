import {
  collectSqliteOperationalMetrics,
  sqliteWriteContentionSnapshot,
} from '@byok-grid/db';
import { workflowWorkerConfig } from './config';
import { workflowDatabase } from './database';
import { dispatchWorkflowRuns } from './dispatcher';
import { hatchetTasks } from './hatchet-tasks';
import { workflowHatchet } from './hatchet';
import { createOperationalMetricsTask } from './operational-metrics';
import { scheduleSqliteSources } from './source-scheduler';
import { runWorkerLifecycle } from './worker-lifecycle';

export async function runHatchetWorker(): Promise<void> {
  const worker = await workflowHatchet.worker('byok-grid-workflow-worker', {
    handleKill: false,
    slots: 10,
    workflows: hatchetTasks,
  });
  await runWorkerLifecycle({
    backgroundTasks: [
      { name: 'workflow dispatcher', run: dispatchWorkflowRuns },
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
    worker,
  });
}
