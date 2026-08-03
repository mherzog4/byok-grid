import { parseMasterKey } from '@byok-grid/security';

let cachedMasterKey: ReturnType<typeof parseMasterKey> | undefined;

export function getDeploymentMasterKey() {
  if (cachedMasterKey) return cachedMasterKey;

  const id = process.env.BYOK_GRID_MASTER_KEY_ID;
  const encoded = process.env.BYOK_GRID_MASTER_KEY;
  if (!id || !encoded) {
    throw new Error(
      'BYOK_GRID_MASTER_KEY_ID and BYOK_GRID_MASTER_KEY are required to store credentials.'
    );
  }
  cachedMasterKey = parseMasterKey(id, encoded);
  return cachedMasterKey;
}
