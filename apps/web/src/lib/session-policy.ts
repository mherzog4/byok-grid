import { isLoopbackUrl } from './runtime-origin';

export const DEFAULT_SESSION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_SESSION_UPDATE_AGE_SECONDS = 24 * 60 * 60;
const MINIMUM_SESSION_EXPIRES_IN_SECONDS = 15 * 60;
const MAXIMUM_SESSION_EXPIRES_IN_SECONDS = 30 * 24 * 60 * 60;
const MINIMUM_SESSION_UPDATE_AGE_SECONDS = 60;

export interface SessionPolicy {
  expiresInSeconds: number;
  refreshEnabled: boolean;
  updateAgeSeconds: number;
}

export class SessionPolicyConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid session policy: ${issues.join(' ')}`);
    this.name = 'SessionPolicyConfigurationError';
  }
}

export function resolveSessionPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env
): SessionPolicy {
  const issues: string[] = [];
  const expiresInSeconds = parseBoundedInteger(
    'BYOK_GRID_SESSION_EXPIRES_IN_SECONDS',
    environment.BYOK_GRID_SESSION_EXPIRES_IN_SECONDS,
    DEFAULT_SESSION_EXPIRES_IN_SECONDS,
    MINIMUM_SESSION_EXPIRES_IN_SECONDS,
    MAXIMUM_SESSION_EXPIRES_IN_SECONDS,
    issues
  );
  const updateAgeSeconds = parseBoundedInteger(
    'BYOK_GRID_SESSION_UPDATE_AGE_SECONDS',
    environment.BYOK_GRID_SESSION_UPDATE_AGE_SECONDS,
    Math.min(
      DEFAULT_SESSION_UPDATE_AGE_SECONDS,
      Math.floor(expiresInSeconds / 2)
    ),
    MINIMUM_SESSION_UPDATE_AGE_SECONDS,
    MAXIMUM_SESSION_EXPIRES_IN_SECONDS,
    issues
  );
  const refreshEnabled = parseBoolean(
    environment.BYOK_GRID_SESSION_REFRESH_ENABLED,
    isLoopbackUrl(environment.BETTER_AUTH_URL),
    issues
  );

  if (updateAgeSeconds >= expiresInSeconds) {
    issues.push(
      'BYOK_GRID_SESSION_UPDATE_AGE_SECONDS must be less than BYOK_GRID_SESSION_EXPIRES_IN_SECONDS.'
    );
  }

  if (issues.length > 0) throw new SessionPolicyConfigurationError(issues);
  return { expiresInSeconds, refreshEnabled, updateAgeSeconds };
}

function parseBoundedInteger(
  name: string,
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  issues: string[]
): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    issues.push(`${name} must be a whole number.`);
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    issues.push(`${name} must be between ${minimum} and ${maximum} seconds.`);
    return fallback;
  }
  return parsed;
}

function parseBoolean(
  value: string | undefined,
  fallback: boolean,
  issues: string[]
): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  issues.push('BYOK_GRID_SESSION_REFRESH_ENABLED must be true or false.');
  return fallback;
}
