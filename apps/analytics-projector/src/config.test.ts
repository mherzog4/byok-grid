import { describe, expect, it } from 'vitest';
import { parseAnalyticsProjectorConfig } from './config';

const base = {
  SQLITE_DATABASE_URL: 'file:./data/byok-grid.sqlite',
  CLICKHOUSE_PASSWORD: 'clickhouse-secret',
  CLICKHOUSE_URL: 'https://clickhouse.example.test',
  CLICKHOUSE_USERNAME: 'projector',
};

describe('analytics projector configuration', () => {
  it('defaults bounded projection and ClickHouse settings', () => {
    expect(
      parseAnalyticsProjectorConfig({
        ...base,
        HOME: '/app',
        PATH: '/usr/local/bin:/usr/bin',
      })
    ).toMatchObject({
      ANALYTICS_PROJECTION_BATCH_SIZE: 100,
      ANALYTICS_PROJECTION_LEASE_SECONDS: 300,
      ANALYTICS_PROJECTION_POLL_SECONDS: 2,
      CLICKHOUSE_ALLOW_INSECURE_HTTP: false,
      CLICKHOUSE_DATABASE: 'byok_grid_analytics',
      CLICKHOUSE_TABLE: 'events',
      BYOK_GRID_DATABASE_MODE: 'local',
      SQLITE_DATABASE_URL: 'file:./data/byok-grid.sqlite',
    });
  });

  it('requires libSQL when remote database mode is selected', () => {
    expect(() =>
      parseAnalyticsProjectorConfig({
        ...base,
        BYOK_GRID_DATABASE_MODE: 'remote',
      })
    ).toThrow(/requires a libsql:\/\/ URL/i);

    expect(
      parseAnalyticsProjectorConfig({
        ...base,
        BYOK_GRID_DATABASE_MODE: 'remote',
        SQLITE_DATABASE_URL: 'libsql://database.example.test',
      }).BYOK_GRID_DATABASE_MODE
    ).toBe('remote');
  });

  it('requires explicit local HTTP and keeps credentials out of the URL', () => {
    expect(() =>
      parseAnalyticsProjectorConfig({
        ...base,
        CLICKHOUSE_URL: 'http://clickhouse.example.test',
      })
    ).toThrow(/requires HTTPS/i);
    expect(() =>
      parseAnalyticsProjectorConfig({
        ...base,
        CLICKHOUSE_URL:
          'https://projector:secret@clickhouse.example.test/?query=SELECT+1',
      })
    ).toThrow(/cannot contain credentials/i);
    expect(
      parseAnalyticsProjectorConfig({
        ...base,
        CLICKHOUSE_ALLOW_INSECURE_HTTP: 'true',
        CLICKHOUSE_URL: 'http://clickhouse:8123',
      }).CLICKHOUSE_ALLOW_INSECURE_HTTP
    ).toBe(true);
  });
});
