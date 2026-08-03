export const SIGNUP_MODES = ['disabled', 'allowlist', 'open'] as const;

export type SignupMode = (typeof SIGNUP_MODES)[number];

export interface SignupPolicy {
  allowedEmails: ReadonlySet<string>;
  mode: SignupMode;
}

type SignupPolicyEnvironment = Readonly<Record<string, string | undefined>>;

export class SignupPolicyConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid signup policy: ${issues.join(' ')}`);
    this.name = 'SignupPolicyConfigurationError';
  }
}

export function resolveSignupPolicy(
  environment: SignupPolicyEnvironment = process.env
): SignupPolicy {
  const issues: string[] = [];
  const mode = parseSignupMode(environment, issues);
  const allowedEmails = parseAllowedEmails(
    environment.BYOK_GRID_SIGNUP_ALLOWED_EMAILS,
    issues
  );

  if (mode === 'allowlist' && allowedEmails.size === 0) {
    issues.push(
      'BYOK_GRID_SIGNUP_ALLOWED_EMAILS must contain at least one email when BYOK_GRID_SIGNUP_MODE is allowlist.'
    );
  }

  if (mode === 'open' && !isLoopbackUrl(environment.BETTER_AUTH_URL)) {
    issues.push(
      'BYOK_GRID_SIGNUP_MODE=open is allowed only for loopback deployments until verified-email delivery is configured.'
    );
  }

  if (issues.length > 0) throw new SignupPolicyConfigurationError(issues);
  return { allowedEmails, mode };
}

export function signupPolicyAllowsEmail(
  policy: SignupPolicy,
  email: string
): boolean {
  if (policy.mode === 'open') return true;
  if (policy.mode === 'disabled') return false;
  return policy.allowedEmails.has(normalizeEmail(email));
}

function parseSignupMode(
  environment: SignupPolicyEnvironment,
  issues: string[]
): SignupMode {
  const configured = environment.BYOK_GRID_SIGNUP_MODE?.trim();
  if (!configured) {
    return isLoopbackUrl(environment.BETTER_AUTH_URL) ? 'open' : 'disabled';
  }
  if ((SIGNUP_MODES as readonly string[]).includes(configured)) {
    return configured as SignupMode;
  }
  issues.push(
    `BYOK_GRID_SIGNUP_MODE must be one of ${SIGNUP_MODES.join(', ')}.`
  );
  return 'disabled';
}

function parseAllowedEmails(value: string | undefined, issues: string[]) {
  const allowedEmails = new Set<string>();
  if (!value?.trim()) return allowedEmails;

  for (const [index, entry] of value.split(',').entries()) {
    const normalized = normalizeEmail(entry);
    if (!isEmailShape(normalized)) {
      issues.push(
        `BYOK_GRID_SIGNUP_ALLOWED_EMAILS contains an invalid entry at position ${index + 1}.`
      );
      continue;
    }
    allowedEmails.add(normalized);
  }
  return allowedEmails;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmailShape(value: string): boolean {
  return /^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/u.test(value);
}

function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, '');
    return (
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}
