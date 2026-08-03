import type { AnalyticsProjectionRow } from '@byok-grid/domain';
import { describe, expect, it } from 'vitest';
import { ClickHouseProjectionClient } from './clickhouse';
import { parseAnalyticsProjectorConfig } from './config';

const password = 'clickhouse-secret-must-stay-in-a-header';
const config = parseAnalyticsProjectorConfig({
  SQLITE_DATABASE_URL: 'file:./data/byok-grid.sqlite',
  CLICKHOUSE_DATABASE: 'byok_grid_analytics',
  CLICKHOUSE_PASSWORD: password,
  CLICKHOUSE_TABLE: 'events',
  CLICKHOUSE_URL: 'https://clickhouse.example.test',
  CLICKHOUSE_USERNAME: 'projector',
});

const row: AnalyticsProjectionRow = {
  aggregate_id: '11111111-1111-4111-8111-111111111111',
  aggregate_type: 'ingestion_batch',
  archived_row_count: 0,
  created_row_count: 1,
  dimension_id: '22222222-2222-4222-8222-222222222222',
  error_code: '',
  event_id: '33333333-3333-4333-8333-333333333333',
  event_type: 'table.ingestion_batch_succeeded',
  occurred_at: '2026-08-01 12:00:00.000',
  outcome: 'succeeded',
  page_count: 0,
  projected_at: '2026-08-01 12:00:01.000',
  record_count: 2,
  restored_row_count: 0,
  table_id: '44444444-4444-4444-8444-444444444444',
  updated_row_count: 1,
  workspace_id: '55555555-5555-4555-8555-555555555555',
};

describe('ClickHouse HTTP projection boundary', () => {
  it('creates a deduplicating table and inserts JSONEachRow with header auth', async () => {
    const requests: Array<{ body: string; headers: Headers; url: string }> = [];
    const client = new ClickHouseProjectionClient(config, {
      fetch: async (url, init) => {
        requests.push({
          body: String(init.body ?? ''),
          headers: new Headers(init.headers),
          url,
        });
        return new Response('');
      },
    });
    await client.ensureSchema();
    await client.insert([row]);
    await client.eraseWorkspace(row.workspace_id);

    expect(requests[0]?.body).toContain(
      'ENGINE = ReplacingMergeTree(projected_at)'
    );
    expect(requests[0]?.body).toContain('ORDER BY (workspace_id, event_id)');
    expect(requests[1]?.body).toContain('ADD COLUMN IF NOT EXISTS');
    const insertUrl = new URL(requests[2]!.url);
    expect(insertUrl.searchParams.get('query')).toBe(
      'INSERT INTO `byok_grid_analytics`.`events` FORMAT JSONEachRow'
    );
    expect(requests[2]?.body).toBe(`${JSON.stringify(row)}\n`);
    expect(requests[2]?.headers.get('x-clickhouse-key')).toBe(password);
    expect(requests.map((request) => request.url).join('\n')).not.toContain(
      password
    );
    expect(requests.map((request) => request.body).join('\n')).not.toContain(
      password
    );
    const eraseUrl = new URL(requests[3]!.url);
    expect(requests[3]?.body).toBe(
      'DELETE FROM `byok_grid_analytics`.`events` WHERE workspace_id = {workspace_id:UUID}'
    );
    expect(eraseUrl.searchParams.get('param_workspace_id')).toBe(
      row.workspace_id
    );
    expect(requests[3]?.body).not.toContain(row.workspace_id);
  });

  it('denies redirects before credentials can move to another origin', async () => {
    const client = new ClickHouseProjectionClient(config, {
      fetch: async () =>
        new Response(null, {
          headers: { location: 'https://attacker.example.test/' },
          status: 307,
        }),
    });
    await expect(client.ensureSchema()).rejects.toThrow(/must not redirect/i);
  });

  it('propagates shutdown cancellation into the active request', async () => {
    let resolveRequestStarted!: (signal: AbortSignal) => void;
    const requestStarted = new Promise<AbortSignal>((resolve) => {
      resolveRequestStarted = resolve;
    });
    const client = new ClickHouseProjectionClient(config, {
      fetch: async (_url, init) => {
        resolveRequestStarted(init.signal!);
        return new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener(
            'abort',
            () => reject(new Error('request aborted')),
            { once: true }
          );
        });
      },
    });
    const controller = new AbortController();
    const schema = client.ensureSchema(controller.signal);

    const requestSignal = await requestStarted;
    controller.abort();

    await expect(schema).rejects.toThrow('ClickHouse could not be reached.');
    expect(requestSignal.aborted).toBe(true);
  });
});
