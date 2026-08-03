import type { AnalyticsProjectionRow } from '@byok-grid/domain';
import type { AnalyticsProjectorConfig } from './config';

const maximumResponseBytes = 64 * 1_024;

export class ClickHouseProjectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClickHouseProjectionError';
  }
}

export interface ClickHouseRuntime {
  fetch(input: string, init: RequestInit): Promise<Response>;
}

export class ClickHouseProjectionClient {
  readonly #config: AnalyticsProjectorConfig;
  readonly #runtime: ClickHouseRuntime;

  constructor(
    config: AnalyticsProjectorConfig,
    runtime: ClickHouseRuntime = { fetch: (input, init) => fetch(input, init) }
  ) {
    this.#config = config;
    this.#runtime = runtime;
  }

  async ensureSchema(signal?: AbortSignal): Promise<void> {
    const table = qualifiedTable(this.#config);
    await this.#execute(
      `
CREATE TABLE IF NOT EXISTS ${table}
(
  event_id UUID,
  workspace_id UUID,
  aggregate_type LowCardinality(String),
  aggregate_id UUID,
  event_type LowCardinality(String),
  outcome LowCardinality(String),
  occurred_at DateTime64(3, 'UTC'),
  projected_at DateTime64(3, 'UTC'),
  table_id Nullable(UUID),
  dimension_id Nullable(UUID),
  record_count UInt64,
  created_row_count UInt64,
  updated_row_count UInt64,
  archived_row_count UInt64,
  restored_row_count UInt64,
  page_count UInt32,
  error_code LowCardinality(String)
)
ENGINE = ReplacingMergeTree(projected_at)
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (workspace_id, event_id)
`,
      undefined,
      signal
    );
    await this.#execute(
      `
ALTER TABLE ${table}
  ADD COLUMN IF NOT EXISTS archived_row_count UInt64 AFTER updated_row_count,
  ADD COLUMN IF NOT EXISTS restored_row_count UInt64 AFTER archived_row_count
`,
      undefined,
      signal
    );
  }

  async insert(
    rows: readonly AnalyticsProjectionRow[],
    signal?: AbortSignal
  ): Promise<void> {
    if (rows.length === 0) return;
    const url = this.#requestUrl(
      `INSERT INTO ${qualifiedTable(this.#config)} FORMAT JSONEachRow`
    );
    await this.#request(
      url,
      {
        body: `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
        headers: { 'content-type': 'application/x-ndjson' },
        method: 'POST',
      },
      signal
    );
  }

  async eraseWorkspace(
    workspaceId: string,
    signal?: AbortSignal
  ): Promise<void> {
    await this.#execute(
      `DELETE FROM ${qualifiedTable(this.#config)} WHERE workspace_id = {workspace_id:UUID}`,
      { workspace_id: workspaceId },
      signal
    );
  }

  async #execute(
    query: string,
    parameters: Readonly<Record<string, string>> = {},
    signal?: AbortSignal
  ): Promise<void> {
    await this.#request(
      this.#requestUrl(undefined, parameters),
      {
        body: query.trim(),
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        method: 'POST',
      },
      signal
    );
  }

  #requestUrl(
    query?: string,
    parameters: Readonly<Record<string, string>> = {}
  ): string {
    const url = new URL(this.#config.CLICKHOUSE_URL);
    url.searchParams.set('database', this.#config.CLICKHOUSE_DATABASE);
    if (query) url.searchParams.set('query', query);
    for (const [name, value] of Object.entries(parameters)) {
      url.searchParams.set(`param_${name}`, value);
    }
    return url.toString();
  }

  async #request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal
  ): Promise<void> {
    let response: Response;
    try {
      response = await this.#runtime.fetch(url, {
        ...init,
        headers: {
          accept: 'text/plain',
          'x-clickhouse-key': this.#config.CLICKHOUSE_PASSWORD,
          'x-clickhouse-user': this.#config.CLICKHOUSE_USERNAME,
          ...(init.headers ?? {}),
        },
        redirect: 'manual',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
          : AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ClickHouseProjectionError('ClickHouse could not be reached.', {
        cause: error,
      });
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new ClickHouseProjectionError(
        'ClickHouse requests must not redirect.'
      );
    }
    const responseBytes = await readBoundedResponse(response);
    if (!response.ok) {
      throw new ClickHouseProjectionError(
        `ClickHouse returned HTTP ${response.status}.`
      );
    }
    if (responseBytes.byteLength > 0) {
      new TextDecoder('utf-8', { fatal: true }).decode(responseBytes);
    }
  }
}

function qualifiedTable(config: AnalyticsProjectorConfig): string {
  return `\`${config.CLICKHOUSE_DATABASE}\`.\`${config.CLICKHOUSE_TABLE}\``;
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumResponseBytes) {
      await reader.cancel();
      throw new ClickHouseProjectionError(
        'ClickHouse returned an oversized response.'
      );
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
