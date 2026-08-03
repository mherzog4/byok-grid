import { describe, expect, it } from 'vitest';
import {
  formatFormulaExpression,
  formulaColumnReference,
  parseFormulaSource,
  type FormulaSourceColumn,
} from './formula-language';
import {
  evaluateFormula,
  FormulaDefinitionError,
  validateFormulaDefinition,
} from './formulas';

const columns: FormulaSourceColumn[] = [
  {
    id: 'f3f63875-1fd6-4cd8-bdf6-05a7269a19a8',
    name: 'Company',
    valueType: 'text',
  },
  {
    id: 'c26ea5ad-f624-45f5-824f-420430497af3',
    name: 'Domain',
    valueType: 'text',
  },
  {
    id: 'd5389521-866a-480e-b8a7-7ac12b9cdb10',
    name: 'Score',
    valueType: 'number',
  },
  {
    id: '614d67c4-0b21-4a68-92d5-a36324865e27',
    name: 'Active',
    valueType: 'boolean',
  },
];

describe('formula source language', () => {
  it('parses, types, evaluates, and canonically formats nested formulas', () => {
    const expression = parseFormulaSource(
      '=CONCAT([company], " @ ", LOWER([Domain]))',
      columns
    );
    expect(
      validateFormulaDefinition(
        expression,
        new Map(columns.map((column) => [column.id, column.valueType]))
      )
    ).toBe('text');
    expect(
      evaluateFormula(
        expression,
        new Map([
          [columns[0]!.id, { type: 'text' as const, value: 'Acme' }],
          [columns[1]!.id, { type: 'text' as const, value: 'ACME.TEST' }],
        ])
      )
    ).toEqual({ type: 'text', value: 'Acme @ acme.test' });
    expect(
      formatFormulaExpression(
        expression,
        new Map(columns.map((column) => [column.id, column.name]))
      )
    ).toBe('CONCAT([Company], " @ ", LOWER([Domain]))');
  });

  it('supports arithmetic, booleans, empty values, and conditionals', () => {
    const expression = parseFormulaSource(
      'IF(EQUALS([Active], TRUE), ADD([Score], 2.5), EMPTY)',
      columns
    );
    expect(
      validateFormulaDefinition(
        expression,
        new Map(columns.map((column) => [column.id, column.valueType]))
      )
    ).toBe('number');
    expect(
      evaluateFormula(
        expression,
        new Map([
          [columns[2]!.id, { type: 'number' as const, value: 4 }],
          [columns[3]!.id, { type: 'boolean' as const, value: true }],
        ])
      )
    ).toEqual({ type: 'number', value: 6.5 });
  });

  it('round-trips escaped column names and typed literal constructors', () => {
    const escapedColumn: FormulaSourceColumn = {
      id: 'f9938dc6-dc02-4ac1-ae49-46b7ea3599c7',
      name: 'Status [raw]',
      valueType: 'text',
    };
    expect(formulaColumnReference(escapedColumn.name)).toBe('[Status [raw]]]');

    const expression = parseFormulaSource(
      'CONCAT([Status [raw]]], TIMESTAMP("2026-08-01T12:00:00-04:00"), JSON("{\\"rank\\":3}"))',
      [escapedColumn]
    );
    expect(expression).toMatchObject({
      args: [
        { columnId: escapedColumn.id, type: 'column' },
        {
          type: 'literal',
          value: { type: 'timestamp', value: '2026-08-01T16:00:00.000Z' },
        },
        { type: 'literal', value: { type: 'json', value: { rank: 3 } } },
      ],
      function: 'concat',
      type: 'call',
    });
    const formatted = formatFormulaExpression(
      expression,
      new Map([[escapedColumn.id, escapedColumn.name]])
    );
    expect(parseFormulaSource(formatted, [escapedColumn])).toEqual(expression);
  });

  it('rejects unknown, ambiguous, malformed, and nondeterministic input', () => {
    expect(() => parseFormulaSource('MYSTERY([Company])', columns)).toThrow(
      /unknown formula function/i
    );
    expect(() => parseFormulaSource('[Missing]', columns)).toThrow(
      /does not exist/i
    );
    expect(() => parseFormulaSource('CONCAT("unterminated)', columns)).toThrow(
      /unterminated string/i
    );
    expect(() =>
      parseFormulaSource('TIMESTAMP("2026-08-01T12:00:00")', columns)
    ).toThrow(/explicit offset/i);
    expect(() =>
      parseFormulaSource('[name]', [
        { ...columns[0]!, name: 'Name' },
        { ...columns[1]!, name: 'NAME' },
      ])
    ).toThrow(/ambiguous/i);
  });

  it('enforces parser depth and node limits before storage', () => {
    expect(() =>
      parseFormulaSource(
        `${'LOWER('.repeat(13)}[Company]${')'.repeat(13)}`,
        columns
      )
    ).toThrow(FormulaDefinitionError);
    expect(() =>
      parseFormulaSource(
        `CONCAT(${Array.from({ length: 129 }, () => '[Company]').join(',')})`,
        columns
      )
    ).toThrow(/at most 128 nodes/i);
  });
});
