import { z } from 'zod';
import { connectorRunModeSchema } from './automatic-enrichment-policy';
import {
  connectorIdentifierSchema,
  connectorVersionSchema,
  entityIdSchema,
} from './identifiers';

export * from './cell-values';
export * from './column-conversion-policy';
export * from './connector-revocation-policy';
export * from './analytics-policy';
export * from './automatic-enrichment-policy';
export * from './bulk-run-policy';
export * from './endpoint-policy';
export * from './formulas';
export * from './formula-language';
export * from './grid-view-policy';
export * from './grid-search-policy';
export * from './identifiers';
export * from './ingestion-policy';
export * from './import-policy';
export * from './source-policy';
export * from './table-policy';
export * from './waterfall-policy';
export * from './webhook-policy';
export * from './writeback-policy';
export * from './workspace-policy';
export * from './workspace-purge-policy';
export * from './workflow-policy';
export * from './workflow-compiler';
export * from './workflow-rows';

export const connectorColumnBindingSchema = z.strictObject({
  columnId: entityIdSchema,
  kind: z.literal('column'),
});

export const connectorLiteralBindingSchema = z
  .strictObject({
    kind: z.literal('literal'),
    value: z.json(),
  })
  .refine(
    (binding) => utf8ByteLength(JSON.stringify(binding.value)) <= 16_384,
    'A connector literal cannot exceed 16 KiB.'
  );

export const connectorActionInputBindingSchema = z.discriminatedUnion('kind', [
  connectorColumnBindingSchema,
  connectorLiteralBindingSchema,
]);

export const connectorActionColumnConfigurationSchema = z
  .strictObject({
    actionId: connectorIdentifierSchema,
    artifactSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    connectorId: connectorIdentifierSchema,
    connectorVersion: connectorVersionSchema.default('1.0.0'),
    credentialId: entityIdSchema.nullable(),
    inputBindings: z
      .record(connectorIdentifierSchema, connectorActionInputBindingSchema)
      .refine(
        (bindings) => Object.keys(bindings).length > 0,
        'A connector action needs at least one input binding.'
      )
      .refine(
        (bindings) => Object.keys(bindings).length <= 32,
        'A connector action cannot bind more than 32 inputs.'
      ),
    kind: z.literal('connector_action'),
    outputValueType: z
      .enum(['boolean', 'json', 'number', 'text'])
      .default('json'),
    protocolVersion: z.enum(['1.0', '1.1']),
    publisherKeyIds: z
      .array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/))
      .max(32)
      .default([]),
    registrySha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable()
      .default(null),
    runMode: connectorRunModeSchema.default('manual'),
  })
  .superRefine((configuration, context) => {
    if (
      configuration.protocolVersion === '1.0' &&
      Object.values(configuration.inputBindings).some(
        (binding) => binding.kind === 'literal'
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Literal connector bindings require protocol 1.1.',
        path: ['inputBindings'],
      });
    }
    if (
      configuration.artifactSha256 === null &&
      (configuration.registrySha256 !== null ||
        configuration.publisherKeyIds.length > 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Registry provenance requires an artifact digest.',
        path: ['artifactSha256'],
      });
    }
  });

export type ConnectorActionInputBinding = z.infer<
  typeof connectorActionInputBindingSchema
>;

export type ConnectorActionColumnConfiguration = z.infer<
  typeof connectorActionColumnConfigurationSchema
>;

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes +=
      codePoint <= 0x7f
        ? 1
        : codePoint <= 0x7ff
          ? 2
          : codePoint <= 0xffff
            ? 3
            : 4;
  }
  return bytes;
}

export const httpEnrichmentColumnConfigurationSchema = z.object({
  actionId: z.literal('request'),
  baseUrl: z.url(),
  connectorId: z.literal('http'),
  credentialId: entityIdSchema.nullable(),
  inputColumnId: entityIdSchema,
  queryParameter: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
  runMode: connectorRunModeSchema.default('manual'),
});

export type HttpEnrichmentColumnConfiguration = z.infer<
  typeof httpEnrichmentColumnConfigurationSchema
>;

export const httpWaterfallProviderConfigurationSchema = z.object({
  baseUrl: z.url(),
  credentialId: entityIdSchema.nullable(),
  id: entityIdSchema,
  name: z.string().trim().min(1).max(80),
  queryParameter: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/),
  resultPath: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/)
    .max(240),
});

export const httpWaterfallColumnConfigurationSchema = z.object({
  inputColumnId: entityIdSchema,
  kind: z.literal('http_waterfall'),
  providers: z
    .array(httpWaterfallProviderConfigurationSchema)
    .min(2)
    .max(10)
    .refine(
      (providers) =>
        new Set(providers.map((provider) => provider.id)).size ===
        providers.length,
      'Provider IDs must be unique.'
    ),
  runMode: connectorRunModeSchema.default('manual'),
  version: z.literal(1),
});

export type HttpWaterfallColumnConfiguration = z.infer<
  typeof httpWaterfallColumnConfigurationSchema
>;

export const httpWaterfallRunPlanSchema = z.object({
  kind: z.literal('http_waterfall'),
  providers: z
    .array(
      z.object({
        credentialId: entityIdSchema.nullable(),
        name: z.string().min(1).max(80),
        providerId: entityIdSchema,
        resultPath: z.string().min(1).max(240),
        url: z.url(),
      })
    )
    .min(2)
    .max(10),
  version: z.literal(1),
});

export type HttpWaterfallRunPlan = z.infer<typeof httpWaterfallRunPlanSchema>;

export const cellRunInputSchema = z.object({
  cellId: entityIdSchema,
  columnId: entityIdSchema,
  credentialId: entityIdSchema.nullable(),
  inputFingerprint: z.string().min(1).max(128),
  rowId: entityIdSchema,
  runId: entityIdSchema,
  workspaceId: entityIdSchema,
});

/**
 * This is intentionally the complete durable workflow payload. Connector
 * inputs are loaded from the authoritative application database by ID so secrets and mutable configuration
 * never become part of Hatchet's retained workflow history.
 */
export type CellRunInput = z.infer<typeof cellRunInputSchema>;

export const cellRunResultSchema = z.object({
  runId: entityIdSchema,
  status: z.enum(['succeeded', 'failed', 'cancelled']),
});

export type CellRunResult = z.infer<typeof cellRunResultSchema>;

export const csvImportInputSchema = z.object({
  importJobId: entityIdSchema,
  tableId: entityIdSchema,
  workspaceId: entityIdSchema,
});

export type CsvImportInput = z.infer<typeof csvImportInputSchema>;
