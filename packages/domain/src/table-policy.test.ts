import { describe, expect, it } from 'vitest';
import {
  createInputColumnRequestSchema,
  createTableRequestSchema,
  defaultFirstColumnName,
  schemaArchiveRequestSchema,
  updateTableRequestSchema,
} from './table-policy';

describe('table policy', () => {
  it('normalizes table and column display names', () => {
    expect(
      createTableRequestSchema.parse({
        firstColumnName: '  Contact  ',
        name: '  Prospects  ',
      })
    ).toEqual({
      firstColumnName: 'Contact',
      firstColumnValueType: 'text',
      name: 'Prospects',
    });
  });

  it('rejects empty, oversized, and control-character names', () => {
    expect(
      createTableRequestSchema.safeParse({ firstColumnName: 'Name', name: ' ' })
        .success
    ).toBe(false);
    expect(
      updateTableRequestSchema.safeParse({ name: 'x'.repeat(121) }).success
    ).toBe(false);
    expect(
      createInputColumnRequestSchema.safeParse({ name: 'Bad\nname' }).success
    ).toBe(false);
  });

  it('uses a neutral first-column default', () => {
    expect(defaultFirstColumnName('Companies')).toBe('Name');
    expect(defaultFirstColumnName('People')).toBe('Name');
  });

  it('accepts every editable input type', () => {
    for (const valueType of [
      'text',
      'number',
      'boolean',
      'timestamp',
      'json',
    ]) {
      expect(
        createInputColumnRequestSchema.parse({ name: 'Typed', valueType })
      ).toEqual({ name: 'Typed', valueType });
    }
  });

  it('normalizes bounded archive confirmations', () => {
    expect(
      schemaArchiveRequestSchema.parse({ confirmationName: '  Prospects  ' })
    ).toEqual({ confirmationName: 'Prospects' });
    expect(
      schemaArchiveRequestSchema.safeParse({ confirmationName: '' }).success
    ).toBe(false);
  });
});
