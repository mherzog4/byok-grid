import { describe, expect, it } from 'vitest';
import { main } from './cli.js';
import type { DestinationRuntime } from './types.js';

const token = `bg_ingest_${'a'.repeat(43)}`;
const endpointUrl =
  'https://grid.example.test/api/ingest/11111111-1111-4111-8111-111111111111';
const config = {
  routes: [
    {
      bearer_token: token,
      endpoint_url: endpointUrl,
      stream: 'companies',
    },
  ],
};
const catalog = {
  streams: [{ destination_sync_mode: 'append', stream: { name: 'companies' } }],
};

describe('Airbyte destination commands', () => {
  it('emits protocol spec and connection status documents', async () => {
    const emitted: string[] = [];
    const runtime = runtimeWithResponses(emitted, [capabilityResponse()]);
    expect(await main(['spec'], { runtime })).toBe(0);
    expect(JSON.parse(emitted.shift()!)).toMatchObject({ type: 'SPEC' });
    expect(
      await main(['check', '--config', '/config.json'], {
        readJson: async () => config,
        runtime,
      })
    ).toBe(0);
    expect(JSON.parse(emitted.shift()!)).toEqual({
      connectionStatus: { status: 'SUCCEEDED' },
      type: 'CONNECTION_STATUS',
    });
  });

  it('runs write and acknowledges state only after batch success', async () => {
    const emitted: string[] = [];
    const runtime = runtimeWithResponses(emitted, [
      capabilityResponse(),
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
      Response.json({ id: 'batch-one', status: 'succeeded' }),
    ]);
    const state = JSON.stringify({
      state: { data: { cursor: 9 } },
      type: 'STATE',
    });
    expect(
      await main(
        ['write', '--config', '/config.json', '--catalog', '/catalog.json'],
        {
          inputLines: lines([
            JSON.stringify({
              record: { data: { id: 'one' }, stream: 'companies' },
              type: 'RECORD',
            }),
            state,
          ]),
          readJson: async (path) =>
            path.includes('catalog') ? catalog : config,
          runtime,
        }
      )
    ).toBe(0);
    expect(emitted).toEqual([state]);
  });

  it('returns a redacted failed connection status', async () => {
    const emitted: string[] = [];
    const runtime = runtimeWithResponses(emitted, [
      Response.json({ error: 'Unauthorized.' }, { status: 401 }),
    ]);
    expect(
      await main(['check', '--config', '/config.json'], {
        readJson: async () => config,
        runtime,
      })
    ).toBe(0);
    const output = emitted.join('\n');
    expect(output).toContain('FAILED');
    expect(output).not.toContain(token);
  });
});

function runtimeWithResponses(
  emitted: string[],
  responses: Response[]
): DestinationRuntime {
  let clock = 0;
  return {
    emit: (line) => emitted.push(line),
    fetch: async () => responses.shift()!,
    now: () => clock,
    randomId: () => 'cli-sync',
    sleep: async (milliseconds) => {
      clock += milliseconds;
    },
  };
}

function capabilityResponse(): Response {
  return Response.json({
    endpointId: '11111111-1111-4111-8111-111111111111',
    maximumBodyBytes: 5_242_880,
    maximumRecords: 1_000,
    recordKeyField: 'id',
    status: 'active',
  });
}

async function* lines(values: string[]): AsyncIterable<string> {
  yield* values;
}
