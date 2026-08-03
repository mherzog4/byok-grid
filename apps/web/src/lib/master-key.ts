import { parseMasterKeyRing } from '@byok-grid/security';

let cachedMasterKeys: ReturnType<typeof parseMasterKeyRing> | undefined;

export function getDeploymentMasterKeys() {
  if (cachedMasterKeys) return cachedMasterKeys;

  const id = process.env.BYOK_GRID_MASTER_KEY_ID;
  const encoded = process.env.BYOK_GRID_MASTER_KEY;
  if (!id || !encoded) {
    throw new Error(
      'BYOK_GRID_MASTER_KEY_ID and BYOK_GRID_MASTER_KEY are required to store credentials.'
    );
  }
  cachedMasterKeys = parseMasterKeyRing(
    id,
    encoded,
    process.env.BYOK_GRID_ADDITIONAL_MASTER_KEYS
  );
  return cachedMasterKeys;
}
