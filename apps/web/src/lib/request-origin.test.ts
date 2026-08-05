import { describe, expect, it } from 'vitest';
import { enforceApiMutationOrigin } from './request-origin';

const publicUrl = 'https://grid.example.com';

describe('API mutation origin boundary', () => {
  it('allows safe methods without browser headers', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(
        enforceApiMutationOrigin(apiRequest(method), publicUrl)
      ).toBeNull();
    }
  });

  it('allows an unsafe request with the canonical Origin', () => {
    expect(
      enforceApiMutationOrigin(
        apiRequest('POST', { origin: publicUrl }),
        `${publicUrl}/`
      )
    ).toBeNull();
  });

  it('allows a cookie-authenticated request with a same-origin Referer', () => {
    expect(
      enforceApiMutationOrigin(
        apiRequest('PATCH', {
          cookie: 'byok-grid.preference=opaque',
          referer: `${publicUrl}/app`,
        }),
        publicUrl
      )
    ).toBeNull();
  });

  it('rejects a mismatched, null, or malformed Origin', async () => {
    for (const origin of ['https://attacker.example', 'null', 'not-a-url']) {
      await expectForbidden(apiRequest('POST', { origin }));
    }
  });

  it('rejects cross-site Fetch Metadata even if Origin is forged', async () => {
    await expectForbidden(
      apiRequest('DELETE', {
        origin: publicUrl,
        'sec-fetch-site': 'cross-site',
      })
    );
  });

  it('fails closed when a cookie-bearing mutation has no provenance', async () => {
    await expectForbidden(
      apiRequest('PUT', { cookie: 'byok-grid.preference=opaque' })
    );
  });

  it('preserves headless Bearer-token clients without browser metadata', () => {
    expect(
      enforceApiMutationOrigin(
        apiRequest('POST', { authorization: 'Bearer opaque-capability' }),
        publicUrl
      )
    ).toBeNull();
  });

  it('fails closed when the canonical public origin is invalid', async () => {
    const response = enforceApiMutationOrigin(
      apiRequest('POST'),
      'https://grid.example.com/unexpected-path'
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    await expect(response?.json()).resolves.toEqual({
      error: 'The web runtime configuration is invalid.',
    });
  });
});

function apiRequest(method: string, headers: HeadersInit = {}): Request {
  return new Request('https://internal-web:3000/api/example', {
    headers,
    method,
  });
}

async function expectForbidden(request: Request): Promise<void> {
  const response = enforceApiMutationOrigin(request, publicUrl);
  expect(response?.status).toBe(403);
  expect(response?.headers.get('cache-control')).toBe('no-store');
  await expect(response?.json()).resolves.toEqual({
    error: 'Cross-origin API mutations are not allowed.',
  });
}
