import { describe, expect, it } from 'vitest';
import {
  createContentSecurityPolicy,
  createContentSecurityPolicyNonce,
} from './content-security-policy';

describe('request-scoped Content Security Policy', () => {
  it('creates unique base64 nonces', () => {
    const first = createContentSecurityPolicyNonce();
    const second = createContentSecurityPolicyNonce();

    expect(first).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(second).toMatch(/^[A-Za-z0-9+/]+={0,2}$/u);
    expect(second).not.toBe(first);
  });

  it('uses the nonce and strict-dynamic without inline script execution', () => {
    const policy = createContentSecurityPolicy('dGVzdC1ub25jZQ==', false);
    const scriptDirective = directive(policy, 'script-src');

    expect(scriptDirective).toContain("'nonce-dGVzdC1ub25jZQ=='");
    expect(scriptDirective).toContain("'strict-dynamic'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(directive(policy, 'style-src')).toContain("'unsafe-inline'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('allows eval only for the Next.js development runtime', () => {
    expect(
      directive(
        createContentSecurityPolicy('dGVzdC1ub25jZQ==', true),
        'script-src'
      )
    ).toContain("'unsafe-eval'");
  });

  it('rejects an unsafe nonce before constructing a header', () => {
    expect(() =>
      createContentSecurityPolicy("bad'; script-src *", false)
    ).toThrow('must be base64');
  });
});

function directive(policy: string, name: string): string {
  const value = policy
    .split('; ')
    .find((candidate) => candidate.startsWith(`${name} `));
  if (!value) throw new Error(`Missing ${name} directive.`);
  return value;
}
