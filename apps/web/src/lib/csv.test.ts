import { describe, expect, it } from 'vitest';
import { formatCsvField } from './csv';

describe('CSV export fields', () => {
  it('quotes delimiters, quotes, and newlines', () => {
    expect(formatCsvField('hello, "world"\nnext')).toBe(
      '"hello, ""world""\nnext"'
    );
  });

  it.each(['=1+1', '+SUM(A:A)', '-2+3', '@cmd', '\tformula', '\rformula'])(
    'neutralizes spreadsheet formula input %s',
    (value) => {
      expect(formatCsvField(value)).toBe(`"'${value}"`);
    }
  );
});
