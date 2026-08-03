import { z } from 'zod';
import {
  normalizeHttpJsonSourceResponse,
  SourceResponseError,
  type NormalizedSourceBatch,
} from './source-policy';

export const MAXIMUM_INGESTION_BODY_BYTES = 5 * 1_048_576;
export const MAXIMUM_INGESTION_RECORDS = 1_000;

const ingestionRecordKeyFieldSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine(
    (value) => !/\p{Cc}/u.test(value),
    'Record key fields cannot contain control characters.'
  );

export const ingestionEndpointRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  recordKeyField: ingestionRecordKeyFieldSchema,
});

export type IngestionEndpointRequest = z.infer<
  typeof ingestionEndpointRequestSchema
>;

export const ingestionIdempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(
    /^[\x21-\x7e]+$/,
    'Idempotency keys must contain visible ASCII characters only.'
  );

export const ingestionEnvelopeSchema = z.strictObject({
  records: z
    .array(z.record(z.string(), z.unknown()))
    .min(1)
    .max(MAXIMUM_INGESTION_RECORDS),
});

export const ingestionBatchInputSchema = z.strictObject({
  batchId: z.string().uuid(),
  endpointId: z.string().uuid(),
  tableId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

export type IngestionBatchInput = z.infer<typeof ingestionBatchInputSchema>;

export type IngestionFieldDecision =
  { kind: 'clear' } | { kind: 'preserve' } | { kind: 'write'; value: string };

/**
 * Controls PATCH-like versus snapshot-like semantics when a known field is
 * missing from an incoming record. Null and empty strings always clear a cell.
 *
 * Push deliveries are PATCH-like because an arbitrary batch does not prove a
 * complete remote snapshot. Explicit null and empty strings still clear.
 */
export function decideIngestionFieldUpdate(
  incoming: string | null | undefined
): IngestionFieldDecision {
  if (incoming === undefined) return { kind: 'preserve' };
  if (incoming === null || incoming === '') return { kind: 'clear' };
  return { kind: 'write', value: incoming };
}

export function normalizeIngestionEnvelope(
  body: unknown,
  recordKeyField: string
): NormalizedSourceBatch {
  const envelope = ingestionEnvelopeSchema.safeParse(body);
  if (!envelope.success) {
    throw new SourceResponseError(
      envelope.error.issues[0]?.message ?? 'The ingestion body is invalid.'
    );
  }
  return normalizeHttpJsonSourceResponse(envelope.data.records, {
    maxRecords: MAXIMUM_INGESTION_RECORDS,
    recordKeyField,
    recordPath: '',
  });
}
