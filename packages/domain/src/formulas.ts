import { z } from 'zod';
import {
  cellValueSchema,
  type CellValue,
  type CellValueType,
} from './cell-values';

export const formulaFunctionSchema = z.enum([
  'add',
  'coalesce',
  'concat',
  'divide',
  'equals',
  'if',
  'lower',
  'multiply',
  'subtract',
  'trim',
  'upper',
]);

export type FormulaFunction = z.infer<typeof formulaFunctionSchema>;

export type FormulaExpression =
  | { type: 'column'; columnId: string }
  | { type: 'literal'; value: CellValue }
  | {
      type: 'call';
      function: FormulaFunction;
      args: FormulaExpression[];
    };

export const formulaExpressionSchema: z.ZodType<FormulaExpression> = z.lazy(
  () =>
    z.discriminatedUnion('type', [
      z.object({ type: z.literal('column'), columnId: z.uuid() }),
      z.object({ type: z.literal('literal'), value: cellValueSchema }),
      z.object({
        type: z.literal('call'),
        function: formulaFunctionSchema,
        args: z.array(formulaExpressionSchema).min(1).max(16),
      }),
    ])
);

export const formulaColumnConfigurationSchema = z.object({
  expression: formulaExpressionSchema,
  version: z.literal(1),
});

export type FormulaColumnConfiguration = z.infer<
  typeof formulaColumnConfigurationSchema
>;

export class FormulaDefinitionError extends Error {}

export const MAXIMUM_FORMULA_DEPTH = 12;
export const MAXIMUM_FORMULA_NODES = 128;

export function collectFormulaColumnIds(
  expression: FormulaExpression
): string[] {
  const ids = new Set<string>();
  walkFormula(expression, (node) => {
    if (node.type === 'column') ids.add(node.columnId);
  });
  return [...ids];
}

export function validateFormulaDefinition(
  expression: FormulaExpression,
  columnTypes: ReadonlyMap<string, CellValueType>
): Exclude<CellValueType, 'empty'> {
  let nodeCount = 0;
  walkFormula(expression, (_node, depth) => {
    nodeCount += 1;
    if (depth > MAXIMUM_FORMULA_DEPTH) {
      throw new FormulaDefinitionError(
        `Formula expressions may be at most ${MAXIMUM_FORMULA_DEPTH} levels deep.`
      );
    }
    if (nodeCount > MAXIMUM_FORMULA_NODES) {
      throw new FormulaDefinitionError(
        `Formula expressions may contain at most ${MAXIMUM_FORMULA_NODES} nodes.`
      );
    }
  });

  const result = inferType(expression, columnTypes);
  if (result === 'empty') {
    throw new FormulaDefinitionError(
      'A formula must be able to produce a non-empty value.'
    );
  }
  return result;
}

export function evaluateFormula(
  expression: FormulaExpression,
  values: ReadonlyMap<string, CellValue>
): CellValue {
  switch (expression.type) {
    case 'column':
      return values.get(expression.columnId) ?? emptyValue();
    case 'literal':
      return expression.value;
    case 'call': {
      const args = expression.args.map((argument) =>
        evaluateFormula(argument, values)
      );
      return evaluateCall(expression.function, args);
    }
  }
}

function evaluateCall(
  fn: FormulaFunction,
  args: readonly CellValue[]
): CellValue {
  switch (fn) {
    case 'concat':
      return {
        type: 'text',
        value: args.map(cellValueToText).join(''),
      };
    case 'lower':
    case 'upper':
    case 'trim': {
      const [value] = args;
      if (!value || value.type === 'empty') return emptyValue();
      const text = cellValueToText(value);
      return {
        type: 'text',
        value:
          fn === 'lower'
            ? text.toLocaleLowerCase()
            : fn === 'upper'
              ? text.toLocaleUpperCase()
              : text.trim(),
      };
    }
    case 'coalesce':
      return args.find((value) => value.type !== 'empty') ?? emptyValue();
    case 'add':
    case 'subtract':
    case 'multiply':
    case 'divide': {
      if (args.some((value) => value.type === 'empty')) return emptyValue();
      const numbers = args.map((value) =>
        value.type === 'number' ? value.value : Number.NaN
      );
      if (numbers.some((value) => !Number.isFinite(value))) return emptyValue();
      const [first = 0, ...rest] = numbers;
      const result = rest.reduce((current, value) => {
        switch (fn) {
          case 'add':
            return current + value;
          case 'subtract':
            return current - value;
          case 'multiply':
            return current * value;
          case 'divide':
            return value === 0 ? Number.NaN : current / value;
          default:
            return current;
        }
      }, first);
      return Number.isFinite(result)
        ? { type: 'number', value: result }
        : emptyValue();
    }
    case 'equals': {
      const [left, right] = args;
      return {
        type: 'boolean',
        value:
          left !== undefined &&
          right !== undefined &&
          left.type === right.type &&
          JSON.stringify(left.value) === JSON.stringify(right.value),
      };
    }
    case 'if': {
      const [condition, whenTrue, whenFalse] = args;
      if (!condition || condition.type !== 'boolean') return emptyValue();
      return condition.value
        ? (whenTrue ?? emptyValue())
        : (whenFalse ?? emptyValue());
    }
  }
}

function inferType(
  expression: FormulaExpression,
  columnTypes: ReadonlyMap<string, CellValueType>
): CellValueType {
  switch (expression.type) {
    case 'column': {
      const type = columnTypes.get(expression.columnId);
      if (!type) {
        throw new FormulaDefinitionError(
          `Formula column ${expression.columnId} is not available.`
        );
      }
      return type;
    }
    case 'literal':
      return expression.value.type;
    case 'call': {
      const types = expression.args.map((argument) =>
        inferType(argument, columnTypes)
      );
      assertArity(expression.function, types.length);
      switch (expression.function) {
        case 'concat':
          return 'text';
        case 'lower':
        case 'upper':
        case 'trim':
          assertTypes(expression.function, types, ['text', 'empty']);
          return 'text';
        case 'add':
        case 'subtract':
        case 'multiply':
        case 'divide':
          assertTypes(expression.function, types, ['number', 'empty']);
          return 'number';
        case 'equals':
          return 'boolean';
        case 'coalesce': {
          const concreteTypes = new Set(
            types.filter((type) => type !== 'empty')
          );
          if (concreteTypes.size > 1) {
            throw new FormulaDefinitionError(
              'COALESCE arguments must have the same value type.'
            );
          }
          return concreteTypes.values().next().value ?? 'empty';
        }
        case 'if': {
          if (types[0] !== 'boolean') {
            throw new FormulaDefinitionError(
              'IF requires a boolean condition as its first argument.'
            );
          }
          const branchTypes = new Set(
            types.slice(1).filter((type) => type !== 'empty')
          );
          if (branchTypes.size > 1) {
            throw new FormulaDefinitionError(
              'IF result branches must have the same value type.'
            );
          }
          return branchTypes.values().next().value ?? 'empty';
        }
      }
    }
  }
}

function assertArity(fn: FormulaFunction, count: number): void {
  const exact: Partial<Record<FormulaFunction, number>> = {
    divide: 2,
    equals: 2,
    if: 3,
    lower: 1,
    multiply: 2,
    subtract: 2,
    trim: 1,
    upper: 1,
  };
  const expected = exact[fn];
  if (expected !== undefined && count !== expected) {
    throw new FormulaDefinitionError(
      `${fn.toUpperCase()} requires exactly ${expected} argument${expected === 1 ? '' : 's'}.`
    );
  }
  if ((fn === 'add' || fn === 'coalesce' || fn === 'concat') && count < 1) {
    throw new FormulaDefinitionError(
      `${fn.toUpperCase()} requires at least one argument.`
    );
  }
}

function assertTypes(
  fn: FormulaFunction,
  actual: readonly CellValueType[],
  allowed: readonly CellValueType[]
): void {
  const invalid = actual.find((type) => !allowed.includes(type));
  if (invalid) {
    throw new FormulaDefinitionError(
      `${fn.toUpperCase()} cannot use a ${invalid} value.`
    );
  }
}

function walkFormula(
  expression: FormulaExpression,
  visit: (node: FormulaExpression, depth: number) => void,
  depth = 1
): void {
  visit(expression, depth);
  if (expression.type === 'call') {
    for (const argument of expression.args) {
      walkFormula(argument, visit, depth + 1);
    }
  }
}

function cellValueToText(value: CellValue): string {
  switch (value.type) {
    case 'empty':
      return '';
    case 'text':
      return value.value;
    case 'number':
    case 'boolean':
      return String(value.value);
    case 'timestamp':
      return value.value;
    case 'json':
      return JSON.stringify(value.value);
  }
}

function emptyValue(): CellValue {
  return { type: 'empty', value: null };
}
