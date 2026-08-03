import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createRequestId,
  INTERNAL_REQUEST_ID_HEADER,
  PUBLIC_REQUEST_ID_HEADER,
  requestIdFromRequest,
  unexpectedApiErrorResponse,
} from './request-correlation';

describe('request correlation', () => {
  afterEach(() => vi.restoreAllMocks());

  it('creates and accepts only canonical random UUIDs', () => {
    const requestId = createRequestId();
    expect(requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    );
    expect(
      requestIdFromRequest(
        new Request('https://grid.test/api', {
          headers: { [INTERNAL_REQUEST_ID_HEADER]: requestId },
        })
      )
    ).toBe(requestId);
    expect(
      requestIdFromRequest(
        new Request('https://grid.test/api', {
          headers: { [INTERNAL_REQUEST_ID_HEADER]: 'client-controlled' },
        })
      )
    ).toBeUndefined();
  });

  it('returns and logs the same identifier without sensitive diagnostics', async () => {
    const requestId = createRequestId();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error(
      'database failed for owner@example.test with token secret-value'
    );
    const response = unexpectedApiErrorResponse(
      'grid',
      error,
      new Request('https://grid.test/api/workspaces/private?token=secret', {
        headers: { [INTERNAL_REQUEST_ID_HEADER]: requestId },
      })
    );

    expect(response.status).toBe(500);
    expect(response.headers.get(PUBLIC_REQUEST_ID_HEADER)).toBe(requestId);
    await expect(response.json()).resolves.toEqual({
      error: 'The request failed.',
      requestId,
    });
    expect(log).toHaveBeenCalledOnce();
    const diagnostic = String(log.mock.calls[0]?.[0]);
    expect(JSON.parse(diagnostic)).toEqual({
      area: 'grid',
      errorName: 'Error',
      event: 'api.unexpected_error',
      requestId,
    });
    expect(diagnostic).not.toContain('owner@example.test');
    expect(diagnostic).not.toContain('secret-value');
    expect(diagnostic).not.toContain('/workspaces/private');
  });

  it('creates correlation when the trusted proxy header is absent', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = unexpectedApiErrorResponse(
      'workflow',
      { unexpected: true },
      new Request('https://grid.test/api')
    );
    expect(response.headers.get(PUBLIC_REQUEST_ID_HEADER)).toMatch(
      /^[0-9a-f-]{36}$/u
    );
  });

  it('bounds attacker-controlled error names before logging', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const error = new Error('private diagnostic');
    error.name = 'DatabaseError\n{"token":"secret"}';

    unexpectedApiErrorResponse(
      'credential',
      error,
      new Request('https://grid.test/api')
    );

    expect(JSON.parse(String(log.mock.calls[0]?.[0])).errorName).toBe('Error');
  });

  it('keeps every route behind the shared unexpected-error contract', async () => {
    const routeFiles = await findRouteFiles(resolve('src/app/api'));
    const offenders: string[] = [];

    for (const path of routeFiles) {
      const source = await readFile(path, 'utf8');
      if (
        /console\.error\(['"]Unexpected/u.test(source) ||
        /\b[A-Za-z]+ErrorResponse\(error\)/u.test(source) ||
        /status:\s*500/u.test(source)
      ) {
        offenders.push(path);
      }
    }

    expect(offenders).toEqual([]);
  });
});

async function findRouteFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return findRouteFiles(path);
      return entry.name === 'route.ts' ? [path] : [];
    })
  );
  return nested.flat().sort();
}
