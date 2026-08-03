import { parseMasterKeyRing } from '@byok-grid/security';
import { config } from './config';

export const workerMasterKeys = parseMasterKeyRing(
  config.BYOK_GRID_MASTER_KEY_ID,
  config.BYOK_GRID_MASTER_KEY,
  config.BYOK_GRID_ADDITIONAL_MASTER_KEYS
);
