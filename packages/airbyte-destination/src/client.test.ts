import { describe, expect, it } from 'vitest';
import {
  AirbyteDestinationRequestError,
  checkEndpoint,
  submitBatch,
} from './client.js';
import type { DestinationRoute, DestinationRuntime } from './types.js';

const route: DestinationRoute = {
  bearerToken: `bg_ingest_${'a'.repeat(43)}`,
  endpointUrl:
    'https://grid.example.test/api/ingest/11111111-1111-4111-8111-111111111111',
  namespace: null,
  stream: 'companies',
};

describe('Airbyte destination HTTP boundary', () => {
  it('validates endpoint capability without exposing the token', async () => {
    const requests: RequestInit[] = [];
    const runtime = createRuntime(async (_url, init) => {
      requests.push(init);
      return Response.json({
        endpointId: '11111111-1111-4111-8111-111111111111',
        maximumBodyBytes: 5_242_880,
        maximumRecords: 1_000,
        recordKeyField: 'id',
        status: 'active',
      });
    });
    await expect(checkEndpoint(route, runtime)).resolves.toMatchObject({
      recordKeyField: 'id',
      status: 'active',
    });
    expect(new Headers(requests[0]?.headers).get('authorization')).toBe(
      `Bearer ${route.bearerToken}`
    );
  });

  it('never follows a cross-origin batch status location', async () => {
    let requestCount = 0;
    const runtime = createRuntime(async () => {
      requestCount += 1;
      return Response.json(
        { id: 'batch-one', status: 'queued' },
        {
          headers: { location: 'https://attacker.example/batches/batch-one' },
          status: 202,
        }
      );
    });
    await expect(
      submitBatch(route, runtime, {
        body: '{"records":[{"id":"one"}]}',
        idempotencyKey: 'airbyte:sync:1:digest',
        timeoutSeconds: 30,
      })
    ).rejects.toBeInstanceOf(AirbyteDestinationRequestError);
    expect(requestCount).toBe(1);
  });

  it('rejects HTTP redirects instead of forwarding authorization', async () => {
    const runtime = createRuntime(
      async () =>
        new Response(null, {
          headers: { location: 'https://attacker.example/' },
          status: 307,
        })
    );
    await expect(checkEndpoint(route, runtime)).rejects.toThrow(
      /must not redirect/i
    );
  });

  it('bounds capability responses even without a content length', async () => {
    const runtime = createRuntime(
      async () => new Response(`{"padding":"${'x'.repeat(70_000)}"}`)
    );
    await expect(checkEndpoint(route, runtime)).rejects.toThrow(/oversized/i);
  });
});

function createRuntime(
  fetchImplementation: DestinationRuntime['fetch']
): DestinationRuntime {
  return {
    emit: () => undefined,
    fetch: fetchImplementation,
    now: () => 0,
    randomId: () => 'sync',
    sleep: async () => undefined,
  };
}
