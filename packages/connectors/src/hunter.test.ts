import { executeAction } from '@byok-grid/connector-sdk';
import { describe, expect, it, vi } from 'vitest';
import { hunterConnector } from './hunter';

function context(fetch: typeof globalThis.fetch) {
  return {
    abortSignal: new AbortController().signal,
    allowedHosts: new Set(['api.hunter.io']),
    fetch,
    idempotencyKey: 'run-hunter-1',
    maxResponseBytes: 16_384,
  };
}

describe('Hunter connector', () => {
  it('injects the API key at execution time and validates the response', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) => {
      const url = new URL(String(request));
      expect(url.hostname).toBe('api.hunter.io');
      expect(url.searchParams.get('domain')).toBe('example.com');
      expect(url.searchParams.get('limit')).toBe('10');
      expect(url.searchParams.get('api_key')).toBe('hunter-secret');
      return new Response(
        JSON.stringify({
          data: {
            domain: 'example.com',
            emails: [
              { confidence: 98, type: 'personal', value: 'ada@example.com' },
            ],
            organization: 'Example',
          },
          meta: { limit: 10, offset: 0, results: 1 },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    });

    await expect(
      executeAction({
        action: hunterConnector.actions.domain_search,
        context: context(fetch),
        credential: { apiKey: 'hunter-secret' },
        credentialSchema: hunterConnector.credentialSchema,
        input: { domain: 'EXAMPLE.COM' },
      })
    ).resolves.toMatchObject({
      data: { emails: [{ value: 'ada@example.com' }] },
      meta: { results: 1 },
    });
  });

  it('classifies Hunter usage limits as retryable', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(new Response('{}', { status: 403 }))
    );

    await expect(
      executeAction({
        action: hunterConnector.actions.domain_search,
        context: context(fetch),
        credential: { apiKey: 'hunter-secret' },
        credentialSchema: hunterConnector.credentialSchema,
        input: { domain: 'example.com' },
      })
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });
});
