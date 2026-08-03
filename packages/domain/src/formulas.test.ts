import { describe, expect, it } from 'vitest';
import {
  collectFormulaColumnIds,
  evaluateFormula,
  FormulaDefinitionError,
  validateFormulaDefinition,
  type FormulaExpression,
} from './formulas';

const companyId = 'f3f63875-1fd6-4cd8-bdf6-05a7269a19a8';
const domainId = 'c26ea5ad-f624-45f5-824f-420430497af3';

describe('formula expressions', () => {
  it('evaluates a nested text formula and collects stable dependencies', () => {
    const expression: FormulaExpression = {
      type: 'call',
      function: 'concat',
      args: [
        { type: 'column', columnId: companyId },
        { type: 'literal', value: { type: 'text', value: ' @ ' } },
        {
          type: 'call',
          function: 'lower',
          args: [{ type: 'column', columnId: domainId }],
        },
      ],
    };

    expect(
      evaluateFormula(
        expression,
        new Map([
          [companyId, { type: 'text' as const, value: 'Acme' }],
          [domainId, { type: 'text' as const, value: 'ACME.EXAMPLE' }],
        ])
      )
    ).toEqual({ type: 'text', value: 'Acme @ acme.example' });
    expect(collectFormulaColumnIds(expression)).toEqual([companyId, domainId]);
    expect(
      validateFormulaDefinition(
        expression,
        new Map([
          [companyId, 'text' as const],
          [domainId, 'text' as const],
        ])
      )
    ).toBe('text');
  });

  it('propagates empty numeric inputs and avoids non-finite output', () => {
    const expression: FormulaExpression = {
      type: 'call',
      function: 'divide',
      args: [
        { type: 'column', columnId: companyId },
        { type: 'column', columnId: domainId },
      ],
    };
    expect(
      evaluateFormula(
        expression,
        new Map([
          [companyId, { type: 'number' as const, value: 4 }],
          [domainId, { type: 'number' as const, value: 0 }],
        ])
      )
    ).toEqual({ type: 'empty', value: null });
  });

  it('rejects incompatible types before a formula is stored', () => {
    const expression: FormulaExpression = {
      type: 'call',
      function: 'add',
      args: [{ type: 'column', columnId: companyId }],
    };
    expect(() =>
      validateFormulaDefinition(expression, new Map([[companyId, 'text']]))
    ).toThrow(FormulaDefinitionError);
  });

  it('chooses the first non-empty COALESCE value', () => {
    const expression: FormulaExpression = {
      type: 'call',
      function: 'coalesce',
      args: [
        { type: 'column', columnId: companyId },
        { type: 'literal', value: { type: 'text', value: 'Unknown' } },
      ],
    };
    expect(evaluateFormula(expression, new Map())).toEqual({
      type: 'text',
      value: 'Unknown',
    });
  });
});
