import { describe, expect, it, vi } from 'vitest';
import { executeAction } from '@byok-grid/connector-sdk';
import { httpConnector } from './http';

function context(fetch: typeof globalThis.fetch) {
  return {
    abortSignal: new AbortController().signal,
    allowedHosts: new Set(['api.example.com']),
    fetch,
    idempotencyKey: 'run-123',
    maxResponseBytes: 1024,
  };
}

describe('HTTP connector', () => {
  it('injects stored credentials and returns bounded JSON', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(
        'Bearer secret-token'
      );
      expect(new Headers(init?.headers).get('idempotency-key')).toBe('run-123');
      return new Response(JSON.stringify({ company: 'Example' }), {
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'provider-request-1',
        },
        status: 200,
      });
    });

    await expect(
      executeAction({
        action: httpConnector.actions.request,
        context: context(fetch),
        credential: { type: 'bearer', token: 'secret-token' },
        credentialSchema: httpConnector.credentialSchema,
        input: { url: 'https://api.example.com/company' },
      })
    ).resolves.toEqual({
      body: { company: 'Example' },
      contentType: 'application/json',
      requestId: 'provider-request-1',
      status: 200,
    });
  });

  it('rejects hosts outside the connector allowlist before fetching', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      executeAction({
        action: httpConnector.actions.request,
        context: context(fetch),
        credential: { type: 'none' },
        credentialSchema: httpConnector.credentialSchema,
        input: { url: 'https://metadata.google.internal/latest' },
      })
    ).rejects.toMatchObject({ code: 'policy', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects redirects so credentials cannot cross hosts', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(null, {
          headers: { location: 'https://attacker.example/collect' },
          status: 302,
        })
      )
    );

    await expect(
      executeAction({
        action: httpConnector.actions.request,
        context: context(fetch),
        credential: { type: 'bearer', token: 'secret-token' },
        credentialSchema: httpConnector.credentialSchema,
        input: { url: 'https://api.example.com/company' },
      })
    ).rejects.toMatchObject({ code: 'policy', retryable: false });
  });

  it('prevents input from overriding the runtime idempotency key', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();

    await expect(
      executeAction({
        action: httpConnector.actions.request,
        context: context(fetch),
        credential: { type: 'none' },
        credentialSchema: httpConnector.credentialSchema,
        input: {
          headers: { 'idempotency-key': 'attacker-controlled' },
          url: 'https://api.example.com/company',
        },
      })
    ).rejects.toMatchObject({ code: 'policy', retryable: false });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a chunked response as soon as it exceeds the byte limit', async () => {
    const cancelled = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            cancel: cancelled,
            start(controller) {
              controller.enqueue(new Uint8Array(700));
              controller.enqueue(new Uint8Array(700));
            },
          }),
          { status: 200 }
        )
      )
    );

    await expect(
      executeAction({
        action: httpConnector.actions.request,
        context: context(fetch),
        credential: { type: 'none' },
        credentialSchema: httpConnector.credentialSchema,
        input: { url: 'https://api.example.com/large' },
      })
    ).rejects.toMatchObject({
      code: 'response_too_large',
      retryable: false,
    });
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('treats other provider 4xx responses as non-retryable input failures', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(new Response('bad request', { status: 400 }))
    );

    await expect(
      executeAction({
        action: httpConnector.actions.request,
        context: context(fetch),
        credential: { type: 'none' },
        credentialSchema: httpConnector.credentialSchema,
        input: { url: 'https://api.example.com/company' },
      })
    ).rejects.toMatchObject({ code: 'invalid_input', retryable: false });
  });
});
