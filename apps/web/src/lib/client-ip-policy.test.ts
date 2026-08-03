import { describe, expect, it } from 'vitest';
import {
  betterAuthIpAddressOptions,
  ClientIpPolicyConfigurationError,
  resolveClientIpPolicy,
} from './client-ip-policy';

describe('client IP policy', () => {
  it('ignores spoofable client-IP headers by default', () => {
    const policy = resolveClientIpPolicy({});
    expect(policy).toEqual({ mode: 'shared-bucket' });
    expect(betterAuthIpAddressOptions(policy)).toEqual({
      ipAddressHeaders: [],
    });
  });

  it('accepts explicit IPv4 and IPv6 proxy boundaries', () => {
    const policy = resolveClientIpPolicy({
      BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS:
        '10.20.0.0/16, 192.0.2.10, 2001:db8:1234::/48',
    });
    expect(betterAuthIpAddressOptions(policy)).toEqual({
      ipAddressHeaders: ['x-forwarded-for'],
      trustedProxies: ['10.20.0.0/16', '192.0.2.10', '2001:db8:1234::/48'],
    });
  });

  it.each([
    'not-an-ip',
    '10.0.0.0/33',
    '2001:db8::/129',
    '0.0.0.0/0',
    '::/0',
    '10.0.0.1,',
    '10.0.0.1,10.0.0.1',
  ])('rejects an unsafe proxy boundary without echoing it: %s', (value) => {
    let error: unknown;
    try {
      resolveClientIpPolicy({
        BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS: value,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ClientIpPolicyConfigurationError);
    expect(String(error)).not.toContain(value);
  });
});
