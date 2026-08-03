import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { config, proxy } from './proxy';

describe('Next.js API proxy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('matches the entire API surface', () => {
    expect(config).toEqual({ matcher: '/api/:path*' });
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
    await expect(response.json()).resolves.toEqual({
      error: 'Cross-origin API mutations are not allowed.',
    });
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
  });
});
