import { parseMasterKeyRing } from '@byok-grid/security';
import { workflowWorkerConfig } from './config';

export const workflowMasterKeys = parseMasterKeyRing(
  workflowWorkerConfig.BYOK_GRID_MASTER_KEY_ID,
  workflowWorkerConfig.BYOK_GRID_MASTER_KEY,
  workflowWorkerConfig.BYOK_GRID_ADDITIONAL_MASTER_KEYS
);
