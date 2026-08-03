import { cellValueSchema, type CellValueType } from './cell-values';
import {
  FormulaDefinitionError,
  formulaFunctionSchema,
  MAXIMUM_FORMULA_DEPTH,
  MAXIMUM_FORMULA_NODES,
  type FormulaExpression,
} from './formulas';

export const MAXIMUM_FORMULA_SOURCE_CHARACTERS = 16_384;

export interface FormulaSourceColumn {
  id: string;
  name: string;
  valueType: CellValueType;
}

export function parseFormulaSource(
  source: string,
  columns: readonly FormulaSourceColumn[]
): FormulaExpression {
  if (source.length > MAXIMUM_FORMULA_SOURCE_CHARACTERS) {
    throw new FormulaDefinitionError(
      `Formula source may contain at most ${MAXIMUM_FORMULA_SOURCE_CHARACTERS} characters.`
    );
  }
  return new FormulaParser(source, columns).parse();
}

export function formatFormulaExpression(
  expression: FormulaExpression,
  columnNames: ReadonlyMap<string, string>
): string {
  switch (expression.type) {
    case 'column': {
      const name = columnNames.get(expression.columnId);
      if (!name) {
        throw new FormulaDefinitionError(
          `Formula column ${expression.columnId} is not available.`
        );
      }
      return `[${escapeFormulaColumnName(name)}]`;
    }
    case 'literal':
      switch (expression.value.type) {
        case 'empty':
          return 'EMPTY';
        case 'text':
          return JSON.stringify(expression.value.value);
        case 'number':
          return String(expression.value.value);
        case 'boolean':
          return expression.value.value ? 'TRUE' : 'FALSE';
        case 'timestamp':
          return `TIMESTAMP(${JSON.stringify(expression.value.value)})`;
        case 'json':
          return `JSON(${JSON.stringify(JSON.stringify(expression.value.value))})`;
      }
    case 'call':
      return `${expression.function.toUpperCase()}(${expression.args
        .map((argument) => formatFormulaExpression(argument, columnNames))
        .join(', ')})`;
  }
}

export function formulaColumnReference(name: string): string {
  return `[${escapeFormulaColumnName(name)}]`;
}

function escapeFormulaColumnName(name: string): string {
  return name.replaceAll(']', ']]');
}

class FormulaParser {
  private index = 0;
  private nodeCount = 0;

  constructor(
    private readonly source: string,
    private readonly columns: readonly FormulaSourceColumn[]
  ) {}

  parse(): FormulaExpression {
    this.skipWhitespace();
    if (this.peek() === '=') {
      this.index += 1;
      this.skipWhitespace();
    }
    if (this.index >= this.source.length) {
      this.fail('Enter a formula expression');
    }
    const expression = this.parseExpression(1);
    this.skipWhitespace();
    if (this.index !== this.source.length) {
      this.fail(`Unexpected ${JSON.stringify(this.peek())}`);
    }
    return expression;
  }

  private parseExpression(depth: number): FormulaExpression {
    if (depth > MAXIMUM_FORMULA_DEPTH) {
      throw new FormulaDefinitionError(
        `Formula expressions may be at most ${MAXIMUM_FORMULA_DEPTH} levels deep.`
      );
    }
    this.skipWhitespace();
    const character = this.peek();
    if (character === '[') return this.parseColumn();
    if (character === '"') {
      return this.node({
        type: 'literal',
        value: { type: 'text', value: this.parseString() },
      });
    }
    if (character === '-' || /[0-9]/u.test(character ?? '')) {
      return this.parseNumber();
    }
    if (/[A-Za-z_]/u.test(character ?? '')) {
      return this.parseIdentifierExpression(depth);
    }
    this.fail('Expected a function, column reference, or literal');
  }

  private parseColumn(): FormulaExpression {
    this.expect('[');
    let name = '';
    while (this.index < this.source.length) {
      const character = this.source[this.index++]!;
      if (character !== ']') {
        name += character;
        continue;
      }
      if (this.peek() === ']') {
        name += ']';
        this.index += 1;
        continue;
      }
      if (!name) this.fail('Column references cannot be empty');
      return this.node({
        type: 'column',
        columnId: this.resolveColumn(name).id,
      });
    }
    this.fail('Unterminated column reference');
  }

  private resolveColumn(name: string): FormulaSourceColumn {
    const exact = this.columns.filter((column) => column.name === name);
    if (exact.length === 1) return exact[0]!;
    if (exact.length > 1) {
      throw new FormulaDefinitionError(
        `Column reference [${name}] is ambiguous.`
      );
    }

    const matches = this.columns.filter((column) =>
      formulaColumnReferenceMatches(name, column.name)
    );
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new FormulaDefinitionError(
        `Column reference [${name}] is ambiguous; match its capitalization exactly.`
      );
    }
    throw new FormulaDefinitionError(`Column [${name}] does not exist.`);
  }

  private parseNumber(): FormulaExpression {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.source.slice(this.index)
    );
    if (!match) this.fail('Enter a valid number');
    this.index += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) this.fail('Numbers must be finite');
    return this.node({ type: 'literal', value: { type: 'number', value } });
  }

  private parseIdentifierExpression(depth: number): FormulaExpression {
    const identifier = this.parseIdentifier().toUpperCase();
    if (identifier === 'TRUE' || identifier === 'FALSE') {
      return this.node({
        type: 'literal',
        value: { type: 'boolean', value: identifier === 'TRUE' },
      });
    }
    if (identifier === 'EMPTY' || identifier === 'NULL') {
      return this.node({
        type: 'literal',
        value: { type: 'empty', value: null },
      });
    }
    if (identifier === 'TIMESTAMP' || identifier === 'JSON') {
      return this.parseLiteralConstructor(identifier);
    }

    const parsedFunction = formulaFunctionSchema.safeParse(
      identifier.toLowerCase()
    );
    if (!parsedFunction.success) {
      throw new FormulaDefinitionError(
        `Unknown formula function ${identifier}.`
      );
    }
    const args = this.parseArguments(depth + 1);
    return this.node({
      type: 'call',
      function: parsedFunction.data,
      args,
    });
  }

  private parseLiteralConstructor(
    constructor: 'JSON' | 'TIMESTAMP'
  ): FormulaExpression {
    this.skipWhitespace();
    this.expect('(');
    this.skipWhitespace();
    const source = this.parseString();
    this.skipWhitespace();
    this.expect(')');
    try {
      if (constructor === 'JSON') {
        return this.node({
          type: 'literal',
          value: cellValueSchema.parse({
            type: 'json',
            value: JSON.parse(source),
          }),
        });
      }
      if (!/(?:[zZ]|[+-]\d{2}:\d{2})$/u.test(source)) {
        throw new TypeError(
          'Timestamp literals require a UTC or offset suffix.'
        );
      }
      const value = new Date(source);
      if (Number.isNaN(value.getTime())) {
        throw new TypeError('Invalid timestamp.');
      }
      return this.node({
        type: 'literal',
        value: { type: 'timestamp', value: value.toISOString() },
      });
    } catch (error) {
      throw new FormulaDefinitionError(
        constructor === 'JSON'
          ? 'JSON() requires a string containing valid JSON.'
          : 'TIMESTAMP() requires an ISO date-time with Z or an explicit offset.',
        { cause: error }
      );
    }
  }

  private parseArguments(depth: number): FormulaExpression[] {
    this.skipWhitespace();
    this.expect('(');
    this.skipWhitespace();
    const args: FormulaExpression[] = [];
    if (this.peek() === ')') {
      this.index += 1;
      return args;
    }
    while (true) {
      args.push(this.parseExpression(depth));
      this.skipWhitespace();
      if (this.peek() === ')') {
        this.index += 1;
        return args;
      }
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    const start = this.index;
    this.expect('"');
    while (this.index < this.source.length) {
      const character = this.source[this.index++]!;
      if (character === '\\') {
        this.index += 1;
        continue;
      }
      if (character === '"') {
        const encoded = this.source.slice(start, this.index);
        try {
          const value: unknown = JSON.parse(encoded);
          if (typeof value !== 'string') throw new TypeError('Not a string.');
          return value;
        } catch (error) {
          throw new FormulaDefinitionError(
            'String literals use JSON escaping.',
            {
              cause: error,
            }
          );
        }
      }
    }
    this.fail('Unterminated string literal');
  }

  private parseIdentifier(): string {
    const start = this.index;
    while (/[A-Za-z0-9_]/u.test(this.peek() ?? '')) this.index += 1;
    return this.source.slice(start, this.index);
  }

  private node<T extends FormulaExpression>(node: T): T {
    this.nodeCount += 1;
    if (this.nodeCount > MAXIMUM_FORMULA_NODES) {
      throw new FormulaDefinitionError(
        `Formula expressions may contain at most ${MAXIMUM_FORMULA_NODES} nodes.`
      );
    }
    return node;
  }

  private expect(expected: string): void {
    if (this.peek() !== expected)
      this.fail(`Expected ${JSON.stringify(expected)}`);
    this.index += 1;
  }

  private skipWhitespace(): void {
    while (/\s/u.test(this.peek() ?? '')) this.index += 1;
  }

  private peek(): string | undefined {
    return this.source[this.index];
  }

  private fail(message: string): never {
    throw new FormulaDefinitionError(
      `${message} at character ${this.index + 1}.`
    );
  }
}

/**
 * CONTRIBUTOR DECISION POINT: this fallback currently forgives Unicode
 * normalization and capitalization differences. Exact matches are resolved
 * before this function is called, and ambiguous fallback matches are rejected.
 */
export function formulaColumnReferenceMatches(
  requestedName: string,
  candidateName: string
): boolean {
  const requested = normalizeFormulaColumnReference(requestedName);
  const candidate = normalizeFormulaColumnReference(candidateName);
  return requested === candidate;
}

function normalizeFormulaColumnReference(name: string): string {
  return name.normalize('NFKC').toLocaleLowerCase('en-US');
}
