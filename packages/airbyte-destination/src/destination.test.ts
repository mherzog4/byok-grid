import { describe, expect, it } from 'vitest';
import { parseConfiguredCatalog, parseDestinationConfig } from './config.js';
import {
  AirbyteDestinationProtocolError,
  AirbyteDestinationWriter,
  checkAllEndpoints,
  normalizeRecord,
  stableStringify,
} from './destination.js';
import { destinationSpecification } from './spec.js';
import type { DestinationRuntime } from './types.js';

const token = `bg_ingest_${'a'.repeat(43)}`;
const endpointUrl =
  'https://grid.example.test/api/ingest/11111111-1111-4111-8111-111111111111';
const capability = {
  endpointId: '11111111-1111-4111-8111-111111111111',
  maximumBodyBytes: 5 * 1_048_576,
  maximumRecords: 1_000,
  recordKeyField: 'id',
  status: 'active' as const,
};

describe('Airbyte destination protocol', () => {
  it('publishes an Airbyte spec with secret route tokens', () => {
    expect(
      destinationSpecification.spec.supported_destination_sync_modes
    ).toEqual(['append', 'append_dedup']);
    const route =
      destinationSpecification.spec.connectionSpecification.properties.routes
        .items.properties;
    expect(route.bearer_token.airbyte_secret).toBe(true);
  });

  it('canonicalizes nested values and fails closed on unsafe integers', () => {
    expect(
      normalizeRecord(
        {
          id: 'one',
          metadata: { b: 2, a: ['x', true] },
        },
        'id'
      )
    ).toEqual({ id: 'one', metadata: '{"a":["x",true],"b":2}' });
    expect(stableStringify({ z: 1, a: 'first' })).toBe('{"a":"first","z":1}');
    expect(
      stableStringify(
        normalizeRecord(
          JSON.parse('{"id":"one","__proto__":"kept as data"}'),
          'id'
        )
      )
    ).toBe('{"__proto__":"kept as data","id":"one"}');
    expect(() =>
      normalizeRecord({ id: 'one', unsafe: 9_007_199_254_740_992 }, 'id')
    ).toThrow(/unsafe integer/i);
  });

  it('flushes before acknowledging state and retries the exact POST safely', async () => {
    const emitted: string[] = [];
    const requests: Array<{
      body: string | null;
      headers: Headers;
      url: string;
    }> = [];
    let clock = 0;
    const responses = [
      new Response('{}', { status: 500 }),
      Response.json(
        { id: 'batch-one', status: 'queued' },
        {
          headers: {
            location:
              '/api/ingest/11111111-1111-4111-8111-111111111111/batches/batch-one',
          },
          status: 202,
        }
      ),
      Response.json({ id: 'batch-one', status: 'running' }),
      Response.json({ id: 'batch-one', status: 'succeeded' }),
    ];
    const runtime: DestinationRuntime = {
      emit: (line) => emitted.push(line),
      fetch: async (url, init) => {
        requests.push({
          body: typeof init.body === 'string' ? init.body : null,
          headers: new Headers(init.headers),
          url,
        });
        return responses.shift()!;
      },
      now: () => clock,
      randomId: () => 'sync-one',
      sleep: async (milliseconds) => {
        clock += milliseconds;
      },
    };
    const config = parseDestinationConfig({
      application_timeout_seconds: 30,
      routes: [
        {
          bearer_token: token,
          endpoint_url: endpointUrl,
          stream: 'companies',
        },
      ],
    });
    const catalog = parseConfiguredCatalog(
      {
        streams: [
          { destination_sync_mode: 'append', stream: { name: 'companies' } },
        ],
      },
      config
    );
    const writer = new AirbyteDestinationWriter({
      capabilities: new Map([['\u0000companies', capability]]),
      catalog,
      config,
      runtime,
    });
    await writer.acceptLine(
      JSON.stringify({
        record: {
          data: { id: 'one', metadata: { score: 7 } },
          stream: 'companies',
        },
        type: 'RECORD',
      })
    );
    expect(emitted).toEqual([]);
    const state = JSON.stringify({
      state: { data: { cursor: 7 } },
      type: 'STATE',
    });
    await writer.acceptLine(state);
    expect(emitted).toEqual([state]);
    expect(requests).toHaveLength(4);
    expect(requests[0]?.body).toBe(requests[1]?.body);
    expect(requests[0]?.headers.get('idempotency-key')).toBe(
      requests[1]?.headers.get('idempotency-key')
    );
    expect(requests[0]?.body).toBe(
      '{"records":[{"id":"one","metadata":"{\\"score\\":7}"}]}'
    );
    expect(requests[2]?.url).toMatch(/\/batches\/batch-one$/);
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${token}`);
  });

  it('rejects records outside the catalog and oversized individual records', async () => {
    const config = parseDestinationConfig({
      batch_maximum_bytes: 65_536,
      routes: [
        {
          bearer_token: token,
          endpoint_url: endpointUrl,
          stream: 'companies',
        },
      ],
    });
    const runtime: DestinationRuntime = {
      emit: () => undefined,
      fetch: async () => {
        throw new Error('not reached');
      },
      now: () => 0,
      randomId: () => 'sync-two',
      sleep: async () => undefined,
    };
    const writer = new AirbyteDestinationWriter({
      capabilities: new Map([['\u0000companies', capability]]),
      catalog: { streams: [{ stream: { name: 'companies' } }] },
      config,
      runtime,
    });
    await expect(
      writer.acceptLine(
        JSON.stringify({
          record: { data: { id: 'one' }, stream: 'contacts' },
          type: 'RECORD',
        })
      )
    ).rejects.toBeInstanceOf(AirbyteDestinationProtocolError);
    await expect(
      writer.acceptLine(
        JSON.stringify({
          record: {
            data: { id: 'one', value: 'x'.repeat(70_000) },
            stream: 'companies',
          },
          type: 'RECORD',
        })
      )
    ).rejects.toThrow(/byte limit/i);
  });

  it('fails check when configured batches exceed server capabilities', async () => {
    const config = parseDestinationConfig({
      batch_maximum_records: 500,
      routes: [
        {
          bearer_token: token,
          endpoint_url: endpointUrl,
          stream: 'companies',
        },
      ],
    });
    const runtime: DestinationRuntime = {
      emit: () => undefined,
      fetch: async () => Response.json({ ...capability, maximumRecords: 100 }),
      now: () => 0,
      randomId: () => 'sync-three',
      sleep: async () => undefined,
    };
    await expect(checkAllEndpoints(config, runtime)).rejects.toThrow(
      /exceed the server capability/i
    );
  });
});
