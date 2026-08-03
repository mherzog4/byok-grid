import { isIP } from 'node:net';
import { isLoopbackHostname } from './runtime-origin';

export const EMAIL_MODES = ['disabled', 'smtp'] as const;
export const AUTHENTICATION_LINK_EXPIRES_IN_SECONDS = 60 * 60;

export type EmailMode = (typeof EMAIL_MODES)[number];

export type EmailPolicy =
  | { mode: 'disabled' }
  | {
      fromEmail: string;
      fromName: string;
      mode: 'smtp';
      smtp: {
        host: string;
        password?: string;
        port: number;
        requireTls: boolean;
        secure: boolean;
        user?: string;
      };
    };

export class EmailPolicyConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid email policy: ${issues.join(' ')}`);
    this.name = 'EmailPolicyConfigurationError';
  }
}

export function resolveEmailPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env
): EmailPolicy {
  const mode = environment.BYOK_GRID_EMAIL_MODE?.trim() || 'disabled';
  if (!(EMAIL_MODES as readonly string[]).includes(mode)) {
    throw new EmailPolicyConfigurationError([
      `BYOK_GRID_EMAIL_MODE must be one of ${EMAIL_MODES.join(', ')}.`,
    ]);
  }
  if (mode === 'disabled') return { mode };

  const issues: string[] = [];
  const secure = parseBoolean(
    'SMTP_SECURE',
    environment.SMTP_SECURE,
    false,
    issues
  );
  const host = parseSmtpHost(environment.SMTP_HOST, issues);
  const port = parsePort(environment.SMTP_PORT, secure ? 465 : 587, issues);
  const requireTls = parseBoolean(
    'SMTP_REQUIRE_TLS',
    environment.SMTP_REQUIRE_TLS,
    true,
    issues
  );
  const fromEmail = parseEmail(
    'SMTP_FROM_EMAIL',
    environment.SMTP_FROM_EMAIL,
    issues
  );
  const fromName = parseHeaderText(
    'SMTP_FROM_NAME',
    environment.SMTP_FROM_NAME || 'BYOK Grid',
    128,
    issues
  );
  const user = optionalCredential('SMTP_USER', environment.SMTP_USER, issues);
  const password = optionalCredential(
    'SMTP_PASSWORD',
    environment.SMTP_PASSWORD,
    issues
  );

  if (Boolean(user) !== Boolean(password)) {
    issues.push(
      'SMTP_USER and SMTP_PASSWORD must either both be set or both be empty.'
    );
  }
  if (!secure && !requireTls && !isLoopbackHostname(host)) {
    issues.push(
      'SMTP_REQUIRE_TLS may be false only when SMTP_HOST targets loopback.'
    );
  }
  if (issues.length > 0) throw new EmailPolicyConfigurationError(issues);

  return {
    fromEmail,
    fromName,
    mode: 'smtp',
    smtp: {
      host,
      ...(password ? { password } : {}),
      port,
      requireTls,
      secure,
      ...(user ? { user } : {}),
    },
  };
}

export function emailDeliveryEnabled(policy: EmailPolicy): boolean {
  return policy.mode === 'smtp';
}

function parseSmtpHost(value: string | undefined, issues: string[]): string {
  const host = value?.trim() || '';
  if (!host) {
    issues.push('SMTP_HOST is required when BYOK_GRID_EMAIL_MODE is smtp.');
    return 'invalid';
  }
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  const hostnameLabels = normalized.split('.');
  const validHostname =
    normalized.length <= 253 &&
    hostnameLabels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)
    );
  if (
    host.length > 253 ||
    /[\s/@?#\\]/u.test(host) ||
    /[\u0000-\u001f\u007f]/u.test(host) ||
    (isIP(normalized) === 0 && !validHostname)
  ) {
    issues.push(
      'SMTP_HOST must be a hostname or IP address without a scheme or path.'
    );
    return 'invalid';
  }
  return normalized;
}

function parsePort(
  value: string | undefined,
  fallback: number,
  issues: string[]
): number {
  if (!value?.trim()) return fallback;
  if (!/^\d+$/u.test(value.trim())) {
    issues.push('SMTP_PORT must be a whole number between 1 and 65535.');
    return fallback;
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    issues.push('SMTP_PORT must be a whole number between 1 and 65535.');
    return fallback;
  }
  return port;
}

function parseBoolean(
  name: string,
  value: string | undefined,
  fallback: boolean,
  issues: string[]
): boolean {
  if (!value?.trim()) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  issues.push(`${name} must be true or false.`);
  return fallback;
}

function parseEmail(
  name: string,
  value: string | undefined,
  issues: string[]
): string {
  const email = value?.trim().toLowerCase() || '';
  if (
    email.length > 254 ||
    !/^[^\s,@]+@[^\s,@]+\.[^\s,@]+$/u.test(email) ||
    /[\u0000-\u001f\u007f]/u.test(email)
  ) {
    issues.push(`${name} must be a single valid email address.`);
    return 'invalid@example.invalid';
  }
  return email;
}

function parseHeaderText(
  name: string,
  value: string,
  maximumLength: number,
  issues: string[]
): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximumLength ||
    /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  ) {
    issues.push(
      `${name} must be non-empty header-safe text up to ${maximumLength} characters.`
    );
    return 'BYOK Grid';
  }
  return normalized;
}

function optionalCredential(
  name: string,
  value: string | undefined,
  issues: string[]
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (
    value.length > 1024 ||
    /[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    issues.push(`${name} must be header-safe text up to 1024 characters.`);
    return undefined;
  }
  return value;
}
