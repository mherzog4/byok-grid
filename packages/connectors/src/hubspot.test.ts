import { describe, expect, it, vi } from 'vitest';
import { executeAction } from '@byok-grid/connector-sdk';
import {
  HUBSPOT_API_HOST,
  hubSpotConnector,
  hubSpotCredentialSchema,
} from './hubspot';

describe('HubSpot contact writeback', () => {
  it('sends a fixed-host, authenticated, idempotent property update', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(
        'Bearer test-private-app-token-123'
      );
      expect(headers.get('idempotency-key')).toBe('delivery-1');
      expect(init?.method).toBe('PATCH');
      expect(JSON.parse(String(init?.body))).toEqual({
        properties: { company: 'Acme', jobtitle: '' },
      });
      return Response.json({ archived: false, id: '12345' });
    });
    await expect(
      executeAction({
        action: hubSpotConnector.actions.update_contact,
        context: {
          abortSignal: new AbortController().signal,
          allowedHosts: new Set([HUBSPOT_API_HOST]),
          fetch,
          idempotencyKey: 'delivery-1',
          maxResponseBytes: 64 * 1_024,
        },
        credential: { accessToken: 'test-private-app-token-123' },
        credentialSchema: hubSpotCredentialSchema,
        input: {
          properties: { company: 'Acme', jobtitle: '' },
          recordId: '12345',
        },
      })
    ).resolves.toMatchObject({ id: '12345' });
    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://api.hubapi.com/crm/objects/2026-03/contacts/12345'
    );
  });

  it('classifies authentication, rate-limit, and input errors', async () => {
    for (const [status, code, retryable] of [
      [401, 'authentication', false],
      [429, 'rate_limited', true],
      [422, 'invalid_input', false],
    ] as const) {
      await expect(
        executeAction({
          action: hubSpotConnector.actions.update_contact,
          context: {
            abortSignal: new AbortController().signal,
            allowedHosts: new Set([HUBSPOT_API_HOST]),
            fetch: async () => new Response(null, { status }),
            idempotencyKey: 'delivery-1',
            maxResponseBytes: 1_024,
          },
          credential: { accessToken: 'test-private-app-token-123' },
          credentialSchema: hubSpotCredentialSchema,
          input: { properties: { company: 'Acme' }, recordId: '12345' },
        })
      ).rejects.toMatchObject({ code, retryable });
    }
  });

  it('searches one frozen incremental contact window', async () => {
    const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) =>
      Response.json({
        paging: { next: { after: 'page-two' } },
        results: [
          {
            archived: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            id: '123',
            properties: { email: 'ada@example.test' },
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      })
    );
    await expect(
      executeAction({
        action: hubSpotConnector.actions.search_changed_contacts,
        context: {
          abortSignal: new AbortController().signal,
          allowedHosts: new Set([HUBSPOT_API_HOST]),
          fetch,
          idempotencyKey: 'source-run:page:1',
          maxResponseBytes: 64 * 1_024,
        },
        credential: { accessToken: 'test-private-app-token-123' },
        credentialSchema: hubSpotCredentialSchema,
        input: {
          after: null,
          properties: ['email'],
          windowEnd: '2026-02-01T00:00:00.000Z',
          windowStart: '2026-01-01T00:00:00.000Z',
        },
      })
    ).resolves.toMatchObject({ paging: { next: { after: 'page-two' } } });
    const [rawUrl, init] = fetch.mock.calls[0]!;
    const url = new URL(String(rawUrl));
    expect(url.hostname).toBe(HUBSPOT_API_HOST);
    expect(url.pathname).toBe('/crm/objects/2026-03/contacts/search');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toMatchObject({
      after: '0',
      limit: 100,
      properties: ['email'],
      sorts: ['hs_lastmodifieddate'],
    });
    expect(String(init?.body)).not.toContain('test-private-app-token');
  });
});
