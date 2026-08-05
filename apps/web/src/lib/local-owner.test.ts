import { beforeEach, describe, expect, it, vi } from 'vitest';

const ensureSqliteLocalUser = vi.fn();

vi.mock('@byok-grid/db', () => ({ ensureSqliteLocalUser }));
vi.mock('./sqlite-database', () => ({ sqliteDb: Symbol('sqlite-db') }));

describe('local workspace owner', () => {
  beforeEach(() => {
    vi.resetModules();
    ensureSqliteLocalUser.mockReset();
    ensureSqliteLocalUser.mockResolvedValue(undefined);
  });

  it('provisions one stable owner once per server process', async () => {
    const { getLocalOwner, localOwner } = await import('./local-owner');

    await expect(getLocalOwner()).resolves.toBe(localOwner);
    await expect(getLocalOwner()).resolves.toBe(localOwner);
    expect(ensureSqliteLocalUser).toHaveBeenCalledTimes(1);
    expect(localOwner).toEqual({
      email: 'local-owner@byok-grid.invalid',
      id: 'local-owner',
      name: 'Local owner',
    });
  });

  it('allows provisioning to retry after a transient failure', async () => {
    ensureSqliteLocalUser
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce(undefined);
    const { getLocalOwner } = await import('./local-owner');

    await expect(getLocalOwner()).rejects.toThrow('database unavailable');
    await expect(getLocalOwner()).resolves.toMatchObject({ id: 'local-owner' });
    expect(ensureSqliteLocalUser).toHaveBeenCalledTimes(2);
  });
});
