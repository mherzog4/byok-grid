import { describe, expect, it } from 'vitest';
import {
  compileSandboxJsonSchema,
  sandboxJsonSchemaMatches,
} from './sandbox-schema';

describe('sandbox connector JSON Schema', () => {
  const schema = {
    additionalProperties: false,
    properties: {
      api_key: { minLength: 8, type: 'string' },
      region: { enum: ['eu', 'us'], type: 'string' },
    },
    required: ['api_key'],
    type: 'object',
  } as const;

  it('compiles once and validates without coercing or removing data', () => {
    expect(compileSandboxJsonSchema(schema)).toBe(
      compileSandboxJsonSchema(schema)
    );
    expect(
      sandboxJsonSchemaMatches(schema, {
        api_key: 'provider-secret',
        region: 'us',
      })
    ).toBe(true);
    expect(sandboxJsonSchemaMatches(schema, { api_key: 'short' })).toBe(false);
    expect(
      sandboxJsonSchemaMatches(schema, {
        api_key: 'provider-secret',
        unexpected: true,
      })
    ).toBe(false);
  });

  it('rejects remote references, async schemas, and unknown keywords', () => {
    expect(() =>
      compileSandboxJsonSchema({ $ref: 'https://example.com/schema.json' })
    ).toThrow(/remote references/);
    expect(() =>
      compileSandboxJsonSchema({ $async: true, type: 'object' })
    ).toThrow(/asynchronous/);
    expect(() =>
      compileSandboxJsonSchema({ type: 'string', unsafeKeyword: true })
    ).toThrow(/unknown keyword/);
  });
});
