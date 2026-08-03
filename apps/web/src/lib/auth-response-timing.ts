export const MINIMUM_ENUMERATION_SENSITIVE_RESPONSE_MS = 500;

const ENUMERATION_SENSITIVE_PATHS = new Set([
  '/api/auth/request-password-reset',
  '/api/auth/send-verification-email',
]);

export function authenticationResponseDelayMs(
  pathname: string,
  elapsedMilliseconds: number
): number {
  if (!ENUMERATION_SENSITIVE_PATHS.has(pathname)) return 0;
  return Math.max(
    0,
    Math.ceil(MINIMUM_ENUMERATION_SENSITIVE_RESPONSE_MS - elapsedMilliseconds)
  );
}
