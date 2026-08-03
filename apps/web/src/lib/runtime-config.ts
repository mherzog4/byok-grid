import { sqliteDatabaseConfigSchema } from '@byok-grid/db';
import { parseMasterKey } from '@byok-grid/security';
import {
  ClientIpPolicyConfigurationError,
  resolveClientIpPolicy,
} from './client-ip-policy';
import {
  EmailPolicyConfigurationError,
  resolveEmailPolicy,
} from './email-policy';
import { isLoopbackHostname } from './runtime-origin';
import {
  resolveSessionPolicy,
  SessionPolicyConfigurationError,
} from './session-policy';
import {
  resolveSignupPolicy,
  SignupPolicyConfigurationError,
} from './signup-policy';

const BETTER_AUTH_MINIMUM_SECRET_LENGTH = 32;
const BUILD_ONLY_SECRET_PREFIX = 'build-only-placeholder';

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
  const authSecret = environment.BETTER_AUTH_SECRET;
  const authUrl = environment.BETTER_AUTH_URL;
  const databaseUrl = environment.SQLITE_DATABASE_URL;
  const masterKey = environment.BYOK_GRID_MASTER_KEY;
  const masterKeyId = environment.BYOK_GRID_MASTER_KEY_ID;

  if (
    !authSecret ||
    authSecret.length < BETTER_AUTH_MINIMUM_SECRET_LENGTH ||
    authSecret.startsWith(BUILD_ONLY_SECRET_PREFIX)
  ) {
    issues.push(
      `BETTER_AUTH_SECRET must be a non-placeholder value of at least ${BETTER_AUTH_MINIMUM_SECRET_LENGTH} characters.`
    );
  }

  if (!authUrl) {
    issues.push('BETTER_AUTH_URL is required.');
  } else {
    validateAuthUrl(authUrl, issues);
  }

  try {
    resolveClientIpPolicy(environment);
  } catch (error) {
    if (error instanceof ClientIpPolicyConfigurationError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }

  try {
    resolveSignupPolicy(environment);
  } catch (error) {
    if (error instanceof SignupPolicyConfigurationError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }

  try {
    resolveEmailPolicy(environment);
  } catch (error) {
    if (error instanceof EmailPolicyConfigurationError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }

  try {
    resolveSessionPolicy(environment);
  } catch (error) {
    if (error instanceof SessionPolicyConfigurationError) {
      issues.push(...error.issues);
    } else {
      throw error;
    }
  }

  const databaseResult = sqliteDatabaseConfigSchema.safeParse({
    ...(environment.SQLITE_AUTH_TOKEN
      ? { authToken: environment.SQLITE_AUTH_TOKEN }
      : {}),
    url: databaseUrl,
  });
  if (!databaseResult.success) {
    issues.push(
      'SQLITE_DATABASE_URL must be a valid file:, :memory:, or libsql:// URL.'
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
      parseMasterKey(masterKeyId, masterKey);
    } catch {
      issues.push(
        'BYOK_GRID_MASTER_KEY must be exactly 32 bytes of canonical base64 and BYOK_GRID_MASTER_KEY_ID must not be empty.'
      );
    }
  }

  if (issues.length > 0) {
    throw new WebRuntimeConfigurationError(issues);
  }
}

function validateAuthUrl(value: string, issues: string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    issues.push('BETTER_AUTH_URL must be an absolute URL.');
    return;
  }

  const loopback = isLoopbackHostname(parsed.hostname);
  if (
    parsed.protocol !== 'https:' &&
    !(parsed.protocol === 'http:' && loopback)
  ) {
    issues.push('BETTER_AUTH_URL must use HTTPS unless it targets loopback.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    issues.push(
      'BETTER_AUTH_URL must not contain credentials, a query string, or a fragment.'
    );
  }
  if (parsed.pathname !== '/') {
    issues.push('BETTER_AUTH_URL must be an origin without a path.');
  }
}
