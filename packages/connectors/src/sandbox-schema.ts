import type { AnySchemaObject, ValidateFunction } from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';

const MAXIMUM_SCHEMA_BYTES = 65_536;
const MAXIMUM_SCHEMA_DEPTH = 32;
const MAXIMUM_SCHEMA_NODES = 2_048;

const ajv = new Ajv2020({
  allErrors: false,
  coerceTypes: false,
  logger: false,
  ownProperties: true,
  removeAdditional: false,
  strict: true,
  useDefaults: false,
  validateFormats: false,
  validateSchema: true,
});

const validators = new WeakMap<object, ValidateFunction>();

export function compileSandboxJsonSchema(
  schema: Readonly<Record<string, unknown>>
): ValidateFunction {
  const cached = validators.get(schema);
  if (cached) return cached;
  assertBoundedSchema(schema);
  const validator = ajv.compile(schema as AnySchemaObject);
  validators.set(schema, validator);
  return validator;
}

export function sandboxJsonSchemaMatches(
  schema: Readonly<Record<string, unknown>>,
  value: unknown
): boolean {
  return Boolean(compileSandboxJsonSchema(schema)(value));
}

function assertBoundedSchema(schema: Readonly<Record<string, unknown>>): void {
  if (Buffer.byteLength(JSON.stringify(schema)) > MAXIMUM_SCHEMA_BYTES) {
    throw new TypeError('Sandbox connector JSON Schema exceeds 64 KiB.');
  }
  const pending: Array<{ depth: number; value: unknown }> = [
    { depth: 0, value: schema },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAXIMUM_SCHEMA_NODES) {
      throw new TypeError('Sandbox connector JSON Schema is too complex.');
    }
    if (current.depth > MAXIMUM_SCHEMA_DEPTH) {
      throw new TypeError(
        'Sandbox connector JSON Schema is too deeply nested.'
      );
    }
    if (Array.isArray(current.value)) {
      for (const value of current.value) {
        pending.push({ depth: current.depth + 1, value });
      }
      continue;
    }
    if (!current.value || typeof current.value !== 'object') continue;
    for (const [key, value] of Object.entries(current.value)) {
      if (
        key === '$ref' &&
        typeof value === 'string' &&
        !value.startsWith('#')
      ) {
        throw new TypeError(
          'Sandbox connector JSON Schema cannot load remote references.'
        );
      }
      if (key === '$async' && value === true) {
        throw new TypeError(
          'Sandbox connector JSON Schema cannot use asynchronous validation.'
        );
      }
      pending.push({ depth: current.depth + 1, value });
    }
  }
}
