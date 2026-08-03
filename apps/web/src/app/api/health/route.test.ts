import { assertSqliteMigrationsReady } from '@byok-grid/db';
import { assertWebRuntimeConfiguration } from '@/lib/runtime-config';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
});
