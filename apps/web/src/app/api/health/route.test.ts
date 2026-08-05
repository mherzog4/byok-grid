import { assertSqliteMigrationsReady } from '@byok-grid/db';
import { assertWebRuntimeConfiguration } from '@/lib/runtime-config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

vi.mock('@byok-grid/db', () => ({
  assertSqliteMigrationsReady: vi.fn(),
}));
vi.mock('@/lib/runtime-config', () => ({
  assertWebRuntimeConfiguration: vi.fn(),
}));
vi.mock('@/lib/sqlite-database', () => ({
  sqliteDatabase: { client: {} },
}));

describe('public readiness response', () => {
  beforeEach(() => {
    vi.mocked(assertSqliteMigrationsReady).mockReset();
    vi.mocked(assertWebRuntimeConfiguration).mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('returns the exact non-cacheable ready contract', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      configuration: 'valid',
      database: 'sqlite',
      status: 'ok',
    });
  });

  it('keeps degraded configuration non-cacheable and detail-free', async () => {
    vi.mocked(assertWebRuntimeConfiguration).mockImplementation(() => {
      throw new Error('sensitive configuration detail');
    });

    const response = await GET();

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      configuration: 'invalid_or_unready',
      database: 'sqlite_unready',
      status: 'degraded',
    });
  });

  it('holds an explicitly enabled drain probe in flight', async () => {
    vi.useFakeTimers();
    vi.stubEnv('BYOK_GRID_WEB_DRAIN_DRILL', '1');
    let settled = false;
    const response = GET(
      new Request('http://127.0.0.1/api/health', {
        headers: { 'x-byok-grid-drain-probe': '1' },
      })
    ).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(749);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect((await response).status).toBe(200);
  });

  it('never delays an ordinary health request', async () => {
    vi.useFakeTimers();
    vi.stubEnv('BYOK_GRID_WEB_DRAIN_DRILL', '1');

    const response = await GET(new Request('http://127.0.0.1/api/health'));

    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});
