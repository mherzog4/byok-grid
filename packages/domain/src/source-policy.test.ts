import { describe, expect, it } from 'vitest';
import {
  decideSourcePageRequest,
  extractNextSourceCursor,
  hubSpotContactsSourceRequestSchema,
  httpJsonSourceRequestSchema,
  nextScheduledSourceRun,
  normalizeHttpJsonSourceResponse,
  normalizeHubSpotContactsSourceResponse,
  scheduleIntervalMinutes,
  shouldArchiveMissingSourceRecords,
  SourceResponseError,
} from './source-policy';

describe('scheduled source policy', () => {
  it('archives missing records only after a complete opt-in snapshot', () => {
    expect(
      shouldArchiveMissingSourceRecords({ completed: true, mode: 'archive' })
    ).toBe(true);
    expect(
      shouldArchiveMissingSourceRecords({ completed: false, mode: 'archive' })
    ).toBe(false);
    expect(
      shouldArchiveMissingSourceRecords({ completed: true, mode: 'preserve' })
    ).toBe(false);
    expect(
      httpJsonSourceRequestSchema.parse({
        credentialId: null,
        maxRecords: 10,
        name: 'Companies',
        recordKeyField: 'id',
        recordPath: '',
        schedule: 'manual',
        url: 'https://api.example.com/companies',
      }).missingRecordMode
    ).toBe('preserve');
  });
  it('coalesces missed intervals instead of replaying a backlog', () => {
    expect(
      nextScheduledSourceRun(
        new Date('2026-01-01T00:00:00Z'),
        15,
        new Date('2026-01-01T01:02:00Z')
      ).toISOString()
    ).toBe('2026-01-01T01:15:00.000Z');
    expect(scheduleIntervalMinutes('daily')).toBe(1_440);
    expect(scheduleIntervalMinutes('manual')).toBeNull();
  });

  it('normalizes a nested record array and preserves first-seen fields', () => {
    expect(
      normalizeHttpJsonSourceResponse(
        { data: { companies: [{ active: true, id: 7, name: 'Acme' }] } },
        { maxRecords: 10, recordKeyField: 'id', recordPath: 'data.companies' }
      )
    ).toEqual({
      fields: ['active', 'id', 'name'],
      records: [
        {
          key: '7',
          values: { active: 'true', id: '7', name: 'Acme' },
        },
      ],
    });
  });

  it('fails closed on duplicate keys, nested values, and oversized batches', () => {
    expect(() =>
      normalizeHttpJsonSourceResponse([{ id: 'same' }, { id: 'same' }], {
        maxRecords: 10,
        recordKeyField: 'id',
        recordPath: '',
      })
    ).toThrow(/duplicate record key/i);
    expect(() =>
      normalizeHttpJsonSourceResponse([{ id: 'one', nested: {} }], {
        maxRecords: 10,
        recordKeyField: 'id',
        recordPath: '',
      })
    ).toThrow(SourceResponseError);
    expect(() =>
      normalizeHttpJsonSourceResponse([{ id: 'one' }, { id: 'two' }], {
        maxRecords: 1,
        recordKeyField: 'id',
        recordPath: '',
      })
    ).toThrow(/more than 1 records/i);
  });

  it('keeps credentials out of stored source URLs', () => {
    const valid = {
      credentialId: null,
      maxRecords: 10,
      name: 'Companies',
      recordKeyField: 'id',
      recordPath: '',
      schedule: 'manual' as const,
    };
    expect(
      httpJsonSourceRequestSchema.safeParse({
        ...valid,
        url: 'https://api.example.com/companies?limit=10',
      }).success
    ).toBe(true);
    for (const url of [
      'http://api.example.com/companies',
      'https://user:secret@api.example.com/companies',
      'https://api.example.com/companies#records',
      'https://api.example.com/companies?api_key=secret',
      'https://api.example.com/companies?api%5Fkey=secret',
    ]) {
      expect(
        httpJsonSourceRequestSchema.safeParse({ ...valid, url }).success
      ).toBe(false);
    }
  });

  it('validates cursor pagination without putting a cursor in configuration', () => {
    const parsed = httpJsonSourceRequestSchema.parse({
      credentialId: null,
      maxRecords: 100,
      name: 'Companies',
      pagination: {
        cursorParameter: 'after',
        maxPages: 12,
        mode: 'cursor',
        nextCursorPath: 'meta.next_cursor',
      },
      recordKeyField: 'id',
      recordPath: 'data.companies',
      schedule: 'manual',
      url: 'https://api.example.com/companies?limit=25',
    });
    expect(parsed.pagination).toEqual({
      cursorParameter: 'after',
      maxPages: 12,
      mode: 'cursor',
      nextCursorPath: 'meta.next_cursor',
    });
    expect(
      httpJsonSourceRequestSchema.safeParse({
        ...parsed,
        url: 'https://api.example.com/companies?after=already-set',
      }).success
    ).toBe(false);
  });

  it('extracts bounded cursors and blocks partial runs at configured limits', () => {
    expect(
      extractNextSourceCursor(
        { meta: { next_cursor: 'opaque-page-two' } },
        'meta.next_cursor'
      )
    ).toBe('opaque-page-two');
    expect(
      extractNextSourceCursor(
        { meta: { next_cursor: null } },
        'meta.next_cursor'
      )
    ).toBeNull();
    expect(() =>
      extractNextSourceCursor({ meta: {} }, 'meta.next_cursor')
    ).toThrow(/cursor path/i);
    expect(
      decideSourcePageRequest({
        maxPages: 10,
        maxRecords: 100,
        pageCount: 10,
        receivedRecordCount: 80,
      })
    ).toEqual({ kind: 'blocked', reason: 'page_limit' });
    expect(
      decideSourcePageRequest({
        maxPages: 10,
        maxRecords: 100,
        pageCount: 2,
        receivedRecordCount: 80,
      })
    ).toEqual({ kind: 'continue' });
  });

  it('rejects fields that differ only by normalized casing', () => {
    expect(() =>
      normalizeHttpJsonSourceResponse([{ id: 'one', Name: 'A', name: 'B' }], {
        maxRecords: 10,
        recordKeyField: 'id',
        recordPath: '',
      })
    ).toThrow(/different casing/i);

    expect(
      normalizeHttpJsonSourceResponse(
        [
          { id: 'one', Name: 'Acme' },
          { id: 'two', name: 'Globex' },
        ],
        { maxRecords: 10, recordKeyField: 'id', recordPath: '' }
      )
    ).toEqual({
      fields: ['id', 'Name'],
      records: [
        { key: 'one', values: { id: 'one', Name: 'Acme' } },
        { key: 'two', values: { id: 'two', Name: 'Globex' } },
      ],
    });
  });

  it('normalizes a bounded HubSpot contact page with a stable contact ID', () => {
    expect(
      normalizeHubSpotContactsSourceResponse(
        {
          paging: { next: { after: 'opaque-next-page' } },
          results: [
            {
              archived: false,
              createdAt: '2026-01-01T00:00:00.000Z',
              id: '12345',
              properties: { email: 'owner@example.test', firstname: 'Ada' },
              updatedAt: '2026-01-02T00:00:00.000Z',
            },
          ],
        },
        { maxRecords: 100, properties: ['email', 'firstname', 'lastname'] }
      )
    ).toEqual({
      batch: {
        fields: [
          'hubspot_contact_id',
          'email',
          'firstname',
          'lastname',
          'hubspot_created_at',
          'hubspot_updated_at',
          'hubspot_archived',
        ],
        records: [
          {
            key: '12345',
            values: {
              email: 'owner@example.test',
              firstname: 'Ada',
              hubspot_archived: 'false',
              hubspot_contact_id: '12345',
              hubspot_created_at: '2026-01-01T00:00:00.000Z',
              hubspot_updated_at: '2026-01-02T00:00:00.000Z',
              lastname: null,
            },
          },
        ],
      },
      nextCursor: 'opaque-next-page',
    });
  });

  it('validates HubSpot source properties and incremental starting point', () => {
    const parsed = hubSpotContactsSourceRequestSchema.parse({
      credentialId: '00000000-0000-4000-8000-000000000001',
      initialSyncFrom: '2026-01-01T00:00:00.000Z',
      name: 'HubSpot contacts',
      properties: ['email', 'firstname', 'lastname'],
      schedule: 'hourly',
    });
    expect(parsed).toMatchObject({ maxPages: 10, maxRecords: 1_000 });
    expect(
      hubSpotContactsSourceRequestSchema.safeParse({
        ...parsed,
        properties: ['Email', 'email'],
      }).success
    ).toBe(false);
    expect(
      hubSpotContactsSourceRequestSchema.safeParse({
        ...parsed,
        properties: ['hubspot_contact_id'],
      }).success
    ).toBe(false);
  });
});
