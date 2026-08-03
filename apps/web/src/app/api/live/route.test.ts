import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('public liveness response', () => {
  it('returns the bounded non-cacheable process contract', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });
});
