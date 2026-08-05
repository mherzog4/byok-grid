import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';
import {
  INTERNAL_REQUEST_ID_HEADER,
  PUBLIC_REQUEST_ID_HEADER,
} from './lib/request-correlation';

describe('Next.js application proxy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('matches application pages and the entire API surface', () => {
    expect(config).toEqual({
      matcher: '/((?!_next/static|_next/image|favicon.ico).*)',
    });
  });

  it('wires the canonical runtime origin into mutation enforcement', async () => {
    vi.stubEnv('BYOK_GRID_PUBLIC_URL', 'https://grid.example.com');
    const response = proxy(
      new NextRequest('https://internal-web:3000/api/workspaces/example', {
        headers: { origin: 'https://attacker.example' },
        method: 'POST',
      })
    );

    expect(response.status).toBe(403);
    expectScriptNoncePolicy(response.headers);
    expectRequestId(response.headers);
    await expect(response.json()).resolves.toEqual({
      error: 'Cross-origin API mutations are not allowed.',
    });
  });

  it('also protects the exact API root', () => {
    vi.stubEnv('BYOK_GRID_PUBLIC_URL', 'https://grid.example.com');
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
    vi.stubEnv('BYOK_GRID_PUBLIC_URL', 'https://grid.example.com');
    const response = proxy(
      new NextRequest('https://internal-web:3000/api/workspaces/example', {
        headers: { origin: 'https://grid.example.com' },
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
    expectScriptNoncePolicy(response.headers);
    const requestId = expectRequestId(response.headers);
    expect(
      response.headers.get(`x-middleware-request-${INTERNAL_REQUEST_ID_HEADER}`)
    ).toBe(requestId);
  });

  it('replaces client-supplied correlation identifiers', () => {
    vi.stubEnv('BYOK_GRID_PUBLIC_URL', 'https://grid.example.com');
    const response = proxy(
      new NextRequest('https://internal-web:3000/app', {
        headers: {
          [INTERNAL_REQUEST_ID_HEADER]: 'attacker-internal-id',
          [PUBLIC_REQUEST_ID_HEADER]: 'attacker-public-id',
        },
      })
    );

    const requestId = expectRequestId(response.headers);
    expect(requestId).not.toContain('attacker');
    expect(
      response.headers.get(`x-middleware-request-${INTERNAL_REQUEST_ID_HEADER}`)
    ).toBe(requestId);
    expect(
      response.headers.get(`x-middleware-request-${PUBLIC_REQUEST_ID_HEADER}`)
    ).toBeNull();
  });

  it('applies a fresh nonce policy to page responses', () => {
    vi.stubEnv('BYOK_GRID_PUBLIC_URL', 'https://grid.example.com');
    const first = proxy(new NextRequest('https://internal-web:3000/app'));
    const second = proxy(new NextRequest('https://internal-web:3000/app'));

    const firstNonce = expectScriptNoncePolicy(first.headers);
    const secondNonce = expectScriptNoncePolicy(second.headers);
    expect(secondNonce).not.toBe(firstNonce);
  });

  it('uses the request origin when a local clone omits a public URL', () => {
    const response = proxy(
      new NextRequest('http://localhost:3000/api/workspaces/example', {
        headers: { origin: 'http://localhost:3000' },
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
  });

  it('uses the request origin when Compose supplies an empty public URL', () => {
    vi.stubEnv('BYOK_GRID_PUBLIC_URL', '');
    const response = proxy(
      new NextRequest('http://localhost:3000/api/workspaces/example', {
        headers: { origin: 'http://localhost:3000' },
        method: 'POST',
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('x-middleware-next')).toBe('1');
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

function expectRequestId(headers: Headers): string {
  const requestId = headers.get(PUBLIC_REQUEST_ID_HEADER);
  expect(requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  );
  return requestId!;
}
