import { describe, expect, it } from 'vitest';
import {
  hubSpotPropertyValue,
  hubSpotRecordId,
  shouldQueueWriteback,
  writebackDestinationRequestSchema,
  writebackPayloadSchema,
} from './writeback-policy';

const uuid = (suffix: number) =>
  `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;

describe('HubSpot writeback policy', () => {
  it('validates unique column and property mappings', () => {
    const columnId = uuid(1);
    const valid = {
      credentialId: uuid(2),
      fieldMappings: [{ columnId, propertyName: 'company_name' }],
      name: 'Update HubSpot contacts',
      recordIdColumnId: uuid(3),
    };
    expect(writebackDestinationRequestSchema.parse(valid)).toEqual({
      ...valid,
      filterTree: { children: [], combinator: 'and' },
      triggerMode: 'manual',
    });
    expect(
      writebackDestinationRequestSchema.safeParse({
        ...valid,
        fieldMappings: [
          ...valid.fieldMappings,
          { columnId, propertyName: 'other_name' },
        ],
      }).success
    ).toBe(false);
    expect(
      writebackDestinationRequestSchema.safeParse({
        ...valid,
        fieldMappings: [
          ...valid.fieldMappings,
          { columnId: uuid(4), propertyName: 'company_name' },
        ],
      }).success
    ).toBe(false);
  });

  it('requires a bounded condition for automatic writeback', () => {
    const automatic = {
      credentialId: uuid(2),
      fieldMappings: [{ columnId: uuid(1), propertyName: 'company_name' }],
      filterTree: {
        children: [{ columnId: uuid(4), operator: 'is_not_empty' as const }],
        combinator: 'and' as const,
      },
      name: 'Qualified contacts',
      recordIdColumnId: uuid(3),
      triggerMode: 'row_settled' as const,
    };
    expect(writebackDestinationRequestSchema.parse(automatic)).toEqual(
      automatic
    );
    expect(
      writebackDestinationRequestSchema.safeParse({
        ...automatic,
        filterTree: { children: [], combinator: 'and' },
      }).success
    ).toBe(false);
  });

  it('serializes scalar cells and uses empty strings to clear properties', () => {
    expect(hubSpotPropertyValue({ type: 'empty', value: null })).toBe('');
    expect(hubSpotPropertyValue({ type: 'number', value: 42 })).toBe('42');
    expect(hubSpotPropertyValue({ type: 'boolean', value: true })).toBe('true');
    expect(() =>
      hubSpotPropertyValue({ type: 'json', value: { nested: true } })
    ).toThrow(/JSON cells/i);
    expect(hubSpotRecordId({ type: 'text', value: ' 12345 ' })).toBe('12345');
  });

  it('accepts only bounded immutable delivery payloads', () => {
    expect(
      writebackPayloadSchema.parse({
        adapterId: 'hubspot_contact',
        deliveryId: uuid(5),
        occurredAt: new Date().toISOString(),
        properties: { company: 'Acme', jobtitle: '' },
        recordId: '12345',
        row: { id: uuid(6), version: 2 },
        tableId: uuid(7),
        version: 1,
        workspaceId: uuid(8),
      })
    ).toMatchObject({ properties: { company: 'Acme', jobtitle: '' } });
  });

  it('exports only input and successfully settled mapped cells', () => {
    expect(shouldQueueWriteback(['idle', 'succeeded'])).toBe(true);
    expect(shouldQueueWriteback(['succeeded', 'running'])).toBe(false);
    expect(shouldQueueWriteback(['stale'])).toBe(false);
    expect(shouldQueueWriteback(['failed'])).toBe(false);
    expect(shouldQueueWriteback(['cancelled'])).toBe(false);
  });
});
