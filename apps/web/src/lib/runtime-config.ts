import { sqliteDatabaseConfigSchema } from '@byok-grid/db';
import { parseMasterKeyRing } from '@byok-grid/security';
import { isLoopbackHostname } from './runtime-origin';

export class WebRuntimeConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid web runtime configuration: ${issues.join(' ')}`);
    this.name = 'WebRuntimeConfigurationError';
  }
}

export function assertWebRuntimeConfiguration(
  environment: NodeJS.ProcessEnv = process.env
): void {
  const issues: string[] = [];
  const publicUrl = environment.BYOK_GRID_PUBLIC_URL;
  const databaseUrl = environment.SQLITE_DATABASE_URL;
  const masterKey = environment.BYOK_GRID_MASTER_KEY;
  const masterKeyId = environment.BYOK_GRID_MASTER_KEY_ID;

  if (publicUrl) validatePublicUrl(publicUrl, issues);

  const databaseResult = sqliteDatabaseConfigSchema.safeParse({
    ...(environment.SQLITE_AUTH_TOKEN
      ? { authToken: environment.SQLITE_AUTH_TOKEN }
      : {}),
    mode: environment.BYOK_GRID_DATABASE_MODE,
    url: databaseUrl,
  });
  if (!databaseResult.success) {
    issues.push(
      'SQLITE_DATABASE_URL must be a valid file:, :memory:, or libsql:// URL; BYOK_GRID_DATABASE_MODE=remote requires libsql://.'
    );
  } else if (
    databaseResult.data.url.startsWith('file:') &&
    databaseResult.data.url.length === 'file:'.length
  ) {
    issues.push('SQLITE_DATABASE_URL must include a file path.');
  }

  if (!masterKey || !masterKeyId) {
    issues.push(
      'BYOK_GRID_MASTER_KEY and BYOK_GRID_MASTER_KEY_ID are required.'
    );
  } else {
    try {
      parseMasterKeyRing(
        masterKeyId,
        masterKey,
        environment.BYOK_GRID_ADDITIONAL_MASTER_KEYS
      );
    } catch {
      issues.push(
        'BYOK_GRID_MASTER_KEY, BYOK_GRID_MASTER_KEY_ID, and BYOK_GRID_ADDITIONAL_MASTER_KEYS form an invalid master-key configuration.'
      );
    }
  }

  if (issues.length > 0) {
    throw new WebRuntimeConfigurationError(issues);
  }
}

function validatePublicUrl(value: string, issues: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push('BYOK_GRID_PUBLIC_URL must be an absolute URL.');
    return;
  }

  const loopback = isLoopbackHostname(parsed.hostname);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && loopback)
  ) {
    issues.push(
      'BYOK_GRID_PUBLIC_URL must use HTTPS unless it targets loopback.'
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    issues.push(
      'BYOK_GRID_PUBLIC_URL must not contain credentials, a query string, or a fragment.'
    );
  }
  if (parsed.pathname !== '/') {
    issues.push('BYOK_GRID_PUBLIC_URL must be an origin without a path.');
  }
}
