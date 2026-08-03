import { describe, expect, it } from 'vitest';
import {
  IngestionBodyTooLargeError,
  readBoundedJsonBody,
  readIngestionBearerToken,
} from './lib/ingestion-api';

describe('bounded ingestion request bodies', () => {
  it('reads JSON bytes without changing the idempotency input', async () => {
    const raw = '{"records":[{"id":"one"}]}';
    const result = await readBoundedJsonBody(
      new Request('https://grid.example.test/api/ingest/example', {
        body: raw,
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    );
    expect(result.body).toEqual({ records: [{ id: 'one' }] });
    expect(new TextDecoder().decode(result.bytes)).toBe(raw);
  });

  it('rejects an oversized declared body before reading the stream', async () => {
    await expect(
      readBoundedJsonBody(
        new Request('https://grid.example.test/api/ingest/example', {
          body: '{}',
          headers: { 'content-length': '5242881' },
          method: 'POST',
        })
      )
    ).rejects.toBeInstanceOf(IngestionBodyTooLargeError);
  });

  it('rejects malformed JSON and invalid UTF-8', async () => {
    await expect(
      readBoundedJsonBody(
        new Request('https://grid.example.test/api/ingest/example', {
          body: '{bad',
          method: 'POST',
        })
      )
    ).rejects.toThrow(/valid JSON/i);
    await expect(
      readBoundedJsonBody(
        new Request('https://grid.example.test/api/ingest/example', {
          body: new Uint8Array([0xff]),
          method: 'POST',
        })
      )
    ).rejects.toThrow(/valid JSON/i);
  });

  it('accepts only the fixed ingestion bearer-token shape', () => {
    const token = `bg_ingest_${'a'.repeat(43)}`;
    expect(
      readIngestionBearerToken(
        new Request('https://grid.example.test', {
          headers: { authorization: `Bearer ${token}` },
        })
      )
    ).toBe(token);
    expect(
      readIngestionBearerToken(
        new Request('https://grid.example.test', {
          headers: { authorization: `Basic ${token}` },
        })
      )
    ).toBeNull();
  });
});
