import { describe, expect, it } from 'vitest';
import { resolveSignupPolicy, signupPolicyAllowsEmail } from './signup-policy';

describe('signup policy', () => {
  it('defaults public deployments to disabled registration', () => {
    const policy = resolveSignupPolicy({
      BETTER_AUTH_URL: 'https://grid.example.com',
    });

    expect(policy.mode).toBe('disabled');
    expect(signupPolicyAllowsEmail(policy, 'owner@example.com')).toBe(false);
  });

  it('defaults loopback evaluation to open registration', () => {
    const policy = resolveSignupPolicy({
      BETTER_AUTH_URL: 'http://127.0.0.1:3000',
    });

    expect(policy.mode).toBe('open');
    expect(signupPolicyAllowsEmail(policy, 'anyone@example.com')).toBe(true);
  });

  it('normalizes and enforces an explicit email allowlist', () => {
    const policy = resolveSignupPolicy({
      BETTER_AUTH_URL: 'https://grid.example.com',
      BYOK_GRID_SIGNUP_ALLOWED_EMAILS:
        ' Owner@Example.com,member@example.com,owner@example.com ',
      BYOK_GRID_SIGNUP_MODE: 'allowlist',
    });

    expect(policy.allowedEmails.size).toBe(2);
    expect(signupPolicyAllowsEmail(policy, 'OWNER@example.com')).toBe(true);
    expect(signupPolicyAllowsEmail(policy, 'attacker@example.com')).toBe(false);
  });

  it('rejects unsafe or incomplete public configuration without echoing data', () => {
    expect(() =>
      resolveSignupPolicy({
        BETTER_AUTH_URL: 'https://grid.example.com',
        BYOK_GRID_SIGNUP_MODE: 'open',
      })
    ).toThrow('open is allowed only for loopback');

    expect(() =>
      resolveSignupPolicy({
        BETTER_AUTH_URL: 'https://grid.example.com',
        BYOK_GRID_SIGNUP_MODE: 'allowlist',
      })
    ).toThrow('must contain at least one email');

    let error: unknown;
    try {
      resolveSignupPolicy({
        BETTER_AUTH_URL: 'https://grid.example.com',
        BYOK_GRID_SIGNUP_ALLOWED_EMAILS: 'sensitive-invalid-address',
        BYOK_GRID_SIGNUP_MODE: 'allowlist',
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('invalid entry at position 1');
    expect(String(error)).not.toContain('sensitive-invalid-address');
  });

  it('rejects unknown modes instead of weakening to open signup', () => {
    expect(() =>
      resolveSignupPolicy({
        BETTER_AUTH_URL: 'http://localhost:3000',
        BYOK_GRID_SIGNUP_MODE: 'enabled',
      })
    ).toThrow('must be one of disabled, allowlist, open');
  });
});
