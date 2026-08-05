import { workflowWorkerConfig } from './config';

if (workflowWorkerConfig.WORKFLOW_EXECUTION_DRIVER === 'hatchet') {
  const { runHatchetWorker } = await import('./hatchet-worker');
  await runHatchetWorker();
} else {
  const { runLocalWorker } = await import('./local-worker');
  await runLocalWorker();
}
