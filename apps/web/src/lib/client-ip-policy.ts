import { isIP } from 'node:net';

export const TRUSTED_PROXY_CIDRS_ENVIRONMENT_VARIABLE =
  'BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS';
export const MAXIMUM_TRUSTED_PROXY_CIDRS = 64;

export type ClientIpPolicy =
  | { mode: 'shared-bucket' }
  | { mode: 'trusted-proxies'; trustedProxies: readonly string[] };

export class ClientIpPolicyConfigurationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid client IP policy: ${issues.join(' ')}`);
    this.name = 'ClientIpPolicyConfigurationError';
  }
}

export function resolveClientIpPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env
): ClientIpPolicy {
  const raw = environment[TRUSTED_PROXY_CIDRS_ENVIRONMENT_VARIABLE]?.trim();
  if (!raw) return { mode: 'shared-bucket' };

  const entries = raw.split(',').map((entry) => entry.trim());
  const issues: string[] = [];
  if (raw.length > 4096) {
    issues.push(
      `${TRUSTED_PROXY_CIDRS_ENVIRONMENT_VARIABLE} must not exceed 4096 characters.`
    );
  }
  if (
    entries.length > MAXIMUM_TRUSTED_PROXY_CIDRS ||
    entries.some((entry) => !entry)
  ) {
    issues.push(
      `${TRUSTED_PROXY_CIDRS_ENVIRONMENT_VARIABLE} must contain between 1 and ${MAXIMUM_TRUSTED_PROXY_CIDRS} comma-separated entries.`
    );
  }

  const uniqueEntries = new Set(entries.map((entry) => entry.toLowerCase()));
  if (uniqueEntries.size !== entries.length) {
    issues.push(
      `${TRUSTED_PROXY_CIDRS_ENVIRONMENT_VARIABLE} must not contain duplicate entries.`
    );
  }
  if (entries.some((entry) => !isValidProxyAddressOrCidr(entry))) {
    issues.push(
      `${TRUSTED_PROXY_CIDRS_ENVIRONMENT_VARIABLE} must contain only IP addresses or bounded CIDR ranges; trust-all /0 ranges are forbidden.`
    );
  }

  if (issues.length > 0) throw new ClientIpPolicyConfigurationError(issues);
  return { mode: 'trusted-proxies', trustedProxies: entries };
}

export function betterAuthIpAddressOptions(policy: ClientIpPolicy): {
  ipAddressHeaders: string[];
  trustedProxies?: string[];
} {
  if (policy.mode === 'shared-bucket') return { ipAddressHeaders: [] };
  return {
    ipAddressHeaders: ['x-forwarded-for'],
    trustedProxies: [...policy.trustedProxies],
  };
}

function isValidProxyAddressOrCidr(value: string): boolean {
  const parts = value.split('/');
  if (parts.length > 2) return false;
  const address = parts[0] ?? '';
  const version = isIP(address);
  if (version === 0) return false;
  const prefix = parts[1];
  if (prefix === undefined) return true;
  if (!/^(?:0|[1-9]\d*)$/u.test(prefix)) return false;
  const prefixLength = Number(prefix);
  return prefixLength > 0 && prefixLength <= (version === 4 ? 32 : 128);
}
