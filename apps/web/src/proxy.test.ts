import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';

describe('Next.js application proxy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('matches application pages and the entire API surface', () => {
    expect(config).toEqual({
      matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
    });
  });

  it('wires the canonical runtime origin into mutation enforcement', async () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://grid.example.com');
    const response = proxy(
      new NextRequest('https://internal-web:3000/api/workspaces/example', {
        headers: { origin: 'https://attacker.example' },
        method: 'POST',
      })
    );

    expect(response.status).toBe(403);
    expectScriptNoncePolicy(response.headers);
    await expect(response.json()).resolves.toEqual({
      error: 'Cross-origin API mutations are not allowed.',
    });
  });

  it('also protects the exact API root', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://grid.example.com');
    const response = proxy(
      new NextRequest('https://internal-web:3000/api', {
        headers: { origin: 'https://attacker.example' },
        method: 'POST',
      })
    );

    expect(response.status).toBe(403);
    expectScriptNoncePolicy(response.headers);
  });

  it('continues same-origin requests to the matched route', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://grid.example.com');
    const response = proxy(
      new NextRequest('https://internal-web:3000/api/workspaces/example', {
        headers: { origin: 'https://grid.example.com' },
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expectScriptNoncePolicy(response.headers);
  });

  it('applies a fresh nonce policy to page responses', () => {
    vi.stubEnv('BETTER_AUTH_URL', 'https://grid.example.com');
    const first = proxy(new NextRequest('https://internal-web:3000/app'));
    const second = proxy(new NextRequest('https://internal-web:3000/app'));

    const firstNonce = expectScriptNoncePolicy(first.headers);
    const secondNonce = expectScriptNoncePolicy(second.headers);
    expect(secondNonce).not.toBe(firstNonce);
  });
});

function expectScriptNoncePolicy(headers: Headers): string {
  const policy = headers.get('content-security-policy');
  expect(policy).toBeTruthy();
  const scriptDirective = policy
    ?.split('; ')
    .find((directive) => directive.startsWith('script-src '));
  expect(scriptDirective).toContain("'strict-dynamic'");
  expect(scriptDirective).not.toContain("'unsafe-inline'");
  const nonce = scriptDirective?.match(/'nonce-([^']+)'/u)?.[1];
  expect(nonce).toBeTruthy();
  return nonce!;
}
