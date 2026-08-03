import { describe, expect, it } from 'vitest';
import {
  decideIngestionFieldUpdate,
  ingestionEndpointRequestSchema,
  ingestionIdempotencyKeySchema,
  normalizeIngestionEnvelope,
} from './ingestion-policy';

describe('push ingestion policy', () => {
  it('normalizes flat scalar records around a stable key', () => {
    expect(
      normalizeIngestionEnvelope(
        { records: [{ active: true, company: 'Acme', id: 42 }] },
        'id'
      )
    ).toEqual({
      fields: ['active', 'company', 'id'],
      records: [
        {
          key: '42',
          values: { active: 'true', company: 'Acme', id: '42' },
        },
      ],
    });
  });

  it('rejects nested values, duplicate keys, and empty batches', () => {
    expect(() =>
      normalizeIngestionEnvelope({ records: [{ id: 'one', nested: {} }] }, 'id')
    ).toThrow(/nested or unsupported/i);
    expect(() =>
      normalizeIngestionEnvelope(
        { records: [{ id: 'same' }, { id: 'same' }] },
        'id'
      )
    ).toThrow(/duplicate record key/i);
    expect(() => normalizeIngestionEnvelope({ records: [] }, 'id')).toThrow();
  });

  it('bounds endpoint names, key fields, and idempotency keys', () => {
    expect(
      ingestionEndpointRequestSchema.safeParse({
        name: 'Airbyte companies',
        recordKeyField: 'company_id',
      }).success
    ).toBe(true);
    expect(
      ingestionIdempotencyKeySchema.safeParse('airbyte-job-42').success
    ).toBe(true);
    expect(ingestionIdempotencyKeySchema.safeParse('short').success).toBe(
      false
    );
    expect(ingestionIdempotencyKeySchema.safeParse('bad key').success).toBe(
      false
    );
  });

  it('uses patch semantics for omitted fields and clears explicit empties', () => {
    expect(decideIngestionFieldUpdate(undefined)).toEqual({
      kind: 'preserve',
    });
    expect(decideIngestionFieldUpdate(null)).toEqual({ kind: 'clear' });
    expect(decideIngestionFieldUpdate('Acme')).toEqual({
      kind: 'write',
      value: 'Acme',
    });
  });
});
