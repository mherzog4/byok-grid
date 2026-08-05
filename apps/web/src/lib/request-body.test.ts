import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAXIMUM_API_JSON_BODY_BYTES, readApiJsonBody } from './request-body';

describe('bounded API JSON bodies', () => {
  it('parses JSON at the exact UTF-8 byte boundary', async () => {
    const body = JSON.stringify({ value: 'é' });
    const bytes = new TextEncoder().encode(body).byteLength;
    const result = await readApiJsonBody(jsonRequest(body), bytes);

    expect(result).toEqual({ value: 'é' });
  });

  it('rejects an oversized declared length without reading the stream', async () => {
    let cancelled = false;
    const request = streamRequest(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('{}'));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { 'content-length': '6' }
    );

    const result = await readApiJsonBody(request, 5);
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(413);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(cancelled).toBe(true);
  });

  it('cancels a chunked body as soon as observed bytes cross the limit', async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const request = streamRequest(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('{"a":'));
          controller.enqueue(encoder.encode('12345}'));
        },
        cancel() {
          cancelled = true;
        },
      })
    );

    const result = await readApiJsonBody(request, 8);
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(413);
    expect(cancelled).toBe(true);
  });

  it('preserves existing route validation for empty, malformed, and invalid UTF-8 bodies', async () => {
    const invalidUtf8 = streamRequest(
      new ReadableStream({
        start(controller) {
          controller.enqueue(Uint8Array.of(0xc3, 0x28));
          controller.close();
        },
      })
    );

    await expect(
      readApiJsonBody(new Request('https://grid.test/api'))
    ).resolves.toBeNull();
    await expect(readApiJsonBody(jsonRequest('{not-json'))).resolves.toBeNull();
    await expect(readApiJsonBody(invalidUtf8)).resolves.toBeNull();
  });

  it('rejects malformed and unsafe declared lengths', async () => {
    for (const value of ['-1', '1.5', '+1', '9007199254740992']) {
      const result = await readApiJsonBody(
        jsonRequest('{}', { 'content-length': value })
      );
      expect(result).toBeInstanceOf(Response);
      if (!(result instanceof Response)) continue;
      expect(result.status).toBe(400);
    }
  });

  it('accepts a standards-compliant length with leading zeroes', async () => {
    await expect(
      readApiJsonBody(jsonRequest('{}', { 'content-length': '0002' }))
    ).resolves.toEqual({});
  });

  it('rejects compressed bodies before parsing', async () => {
    const result = await readApiJsonBody(
      jsonRequest('{}', { 'content-encoding': 'gzip' })
    );
    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) return;
    expect(result.status).toBe(415);
  });

  it('keeps all App Router API JSON reads behind the bounded reader', async () => {
    const apiDirectory = resolve('src/app/api');
    const routeFiles = await findRouteFiles(apiDirectory);
    const offenders: string[] = [];
    for (const path of routeFiles) {
      const source = await readFile(path, 'utf8');
      if (/\brequest\s*\.\s*json\s*\(/u.test(source)) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it('returns every transport-level body rejection before domain parsing', async () => {
    const apiDirectory = resolve('src/app/api');
    const routeFiles = await findRouteFiles(apiDirectory);
    const offenders: string[] = [];
    const guardedRead =
      /const\s+(\w+)\s*=\s*await\s+readApiJsonBody\(request\);\s*if\s*\(\1\s+instanceof\s+Response\)\s+return\s+\1;/gu;
    for (const path of routeFiles) {
      const source = await readFile(path, 'utf8');
      const reads = source.match(/readApiJsonBody\(request\)/gu)?.length ?? 0;
      const guards = source.match(guardedRead)?.length ?? 0;
      if (reads !== guards) offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  it('retains the production API ceiling', () => {
    expect(MAXIMUM_API_JSON_BODY_BYTES).toBe(5 * 1_048_576);
  });
});

function jsonRequest(body: string, headers: HeadersInit = {}): Request {
  return new Request('https://grid.test/api', {
    body,
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  });
}

function streamRequest(
  body: ReadableStream<Uint8Array>,
  headers: HeadersInit = {}
): Request {
  return new Request('https://grid.test/api', {
    body,
    duplex: 'half',
    headers,
    method: 'POST',
  } as RequestInit & { duplex: 'half' });
}

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
