import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  markApplicationRateLimitResponse,
  RATE_LIMIT_LAYER_HEADER,
} from './rate-limit-response';

describe('application rate-limit response provenance', () => {
  it('marks an application-generated 429 without losing its retry contract', async () => {
    const response = markApplicationRateLimitResponse(
      new Response(JSON.stringify({ message: 'limited' }), {
        headers: {
          'content-type': 'application/json',
          'x-retry-after': '10',
        },
        status: 429,
        statusText: 'Too Many Requests',
      })
    );

    expect(response.status).toBe(429);
    expect(response.statusText).toBe('Too Many Requests');
    expect(response.headers.get(RATE_LIMIT_LAYER_HEADER)).toBe('application');
    expect(response.headers.get('x-retry-after')).toBe('10');
    expect(await response.json()).toEqual({ message: 'limited' });
  });

  it('returns non-rate-limited responses unchanged', () => {
    const response = new Response(null, { status: 401 });
    expect(markApplicationRateLimitResponse(response)).toBe(response);
  });

  it('is wired after the bounded Better Auth POST handler', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '../app/api/auth/[...all]/route.ts'),
      'utf8'
    );
    expect(source).toContain(
      'return markApplicationRateLimitResponse(response);'
    );
  });
});
