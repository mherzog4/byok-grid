import { describe, expect, it } from 'vitest';
import { CsvImportDefinitionError, planCsvColumns } from './import-policy';

describe('CSV import column policy', () => {
  it('reuses input columns case-insensitively', () => {
    expect(
      planCsvColumns(
        [' company '],
        [
          {
            id: 'company-id',
            kind: 'input',
            name: 'Company',
            valueType: 'text',
          },
        ]
      )
    ).toEqual([
      {
        columnName: 'Company',
        existingColumnId: 'company-id',
        header: 'company',
      },
    ]);
  });

  it('suffixes a collision with a computed column', () => {
    expect(
      planCsvColumns(
        ['Score'],
        [
          {
            id: 'score-id',
            kind: 'formula',
            name: 'Score',
            valueType: 'number',
          },
        ]
      )
    ).toEqual([
      {
        columnName: 'Score (import 2)',
        existingColumnId: null,
        header: 'Score',
      },
    ]);
  });

  it('suffixes a collision with a non-text input column', () => {
    expect(
      planCsvColumns(
        ['Score'],
        [
          {
            id: 'score-id',
            kind: 'input',
            name: 'Score',
            valueType: 'number',
          },
        ]
      )
    ).toEqual([
      {
        columnName: 'Score (import 2)',
        existingColumnId: null,
        header: 'Score',
      },
    ]);
  });

  it('rejects duplicate normalized headers', () => {
    expect(() => planCsvColumns(['Domain', ' domain '], [])).toThrow(
      CsvImportDefinitionError
    );
  });

  it('rejects empty and oversized headers', () => {
    expect(() => planCsvColumns(['  '], [])).toThrow('cannot be empty');
    expect(() => planCsvColumns(['x'.repeat(121)], [])).toThrow(
      'exceeds 120 characters'
    );
  });
});
