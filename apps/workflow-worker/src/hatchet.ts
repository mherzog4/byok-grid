import { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import { workflowWorkerConfig } from './config';

export const workflowHatchet = HatchetClient.init({
  api_url: workflowWorkerConfig.HATCHET_CLIENT_API_URL,
  healthcheck: {
    enabled:
      workflowWorkerConfig.HATCHET_CLIENT_WORKER_HEALTHCHECK_ENABLED === 'true',
    port: workflowWorkerConfig.HATCHET_CLIENT_WORKER_HEALTHCHECK_PORT,
  },
  host_port: workflowWorkerConfig.HATCHET_CLIENT_HOST_PORT,
  tls_config: {
    tls_strategy: workflowWorkerConfig.HATCHET_CLIENT_TLS_STRATEGY,
  },
  token: workflowWorkerConfig.HATCHET_CLIENT_TOKEN,
});
