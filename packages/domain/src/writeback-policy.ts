import { z } from 'zod';
import { cellValueSchema, type CellValue } from './cell-values';
import {
  gridViewFilterLeaves,
  gridViewFilterTreeSchema,
  type GridViewFilterGroup,
} from './grid-view-policy';

export const MAXIMUM_WRITEBACK_PAYLOAD_BYTES = 128 * 1_024;
export const MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE = 20;

const hubSpotPropertyNameSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z][a-z0-9_]{0,99}$/,
    'HubSpot property names must use lowercase letters, numbers, and underscores.'
  );

const writebackFieldMappingSchema = z.strictObject({
  columnId: z.string().uuid(),
  propertyName: hubSpotPropertyNameSchema,
});

export const writebackTriggerModeSchema = z.enum(['manual', 'row_settled']);
export type WritebackTriggerMode = z.infer<typeof writebackTriggerModeSchema>;

const emptyWritebackFilterTree: GridViewFilterGroup = {
  children: [],
  combinator: 'and',
};

export const writebackDestinationRequestSchema = z
  .strictObject({
    credentialId: z.string().uuid(),
    fieldMappings: z.array(writebackFieldMappingSchema).min(1).max(50),
    filterTree: gridViewFilterTreeSchema.default(emptyWritebackFilterTree),
    name: z.string().trim().min(1).max(120),
    recordIdColumnId: z.string().uuid(),
    triggerMode: writebackTriggerModeSchema.default('manual'),
  })
  .superRefine((destination, context) => {
    const columnIds = new Set<string>();
    const propertyNames = new Set<string>();
    for (const [index, mapping] of destination.fieldMappings.entries()) {
      if (columnIds.has(mapping.columnId)) {
        context.addIssue({
          code: 'custom',
          message: 'A grid column can be mapped only once.',
          path: ['fieldMappings', index, 'columnId'],
        });
      }
      if (propertyNames.has(mapping.propertyName)) {
        context.addIssue({
          code: 'custom',
          message: 'A HubSpot property can be mapped only once.',
          path: ['fieldMappings', index, 'propertyName'],
        });
      }
      columnIds.add(mapping.columnId);
      propertyNames.add(mapping.propertyName);
    }
    if (
      destination.triggerMode === 'row_settled' &&
      gridViewFilterLeaves(destination.filterTree).length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Automatic writeback requires at least one row condition.',
        path: ['filterTree'],
      });
    }
  });

export type WritebackDestinationRequest = z.infer<
  typeof writebackDestinationRequestSchema
>;
export type WritebackDestinationRequestInput = z.input<
  typeof writebackDestinationRequestSchema
>;

export const writebackDestinationUpdateSchema = z
  .strictObject({
    filterTree: gridViewFilterTreeSchema.optional(),
    status: z.enum(['active', 'paused']).optional(),
    triggerMode: writebackTriggerModeSchema.optional(),
  })
  .refine(
    (update) =>
      update.filterTree !== undefined ||
      update.status !== undefined ||
      update.triggerMode !== undefined,
    'At least one writeback destination setting is required.'
  );

export type WritebackDestinationUpdate = z.infer<
  typeof writebackDestinationUpdateSchema
>;

export const writebackDeliveryRequestSchema = z.strictObject({
  deliveryId: z.string().uuid(),
  rowId: z.string().uuid(),
});

export const writebackDeliveryInputSchema = z.strictObject({
  deliveryId: z.string().uuid(),
  destinationId: z.string().uuid(),
  tableId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

export type WritebackDeliveryInput = z.infer<
  typeof writebackDeliveryInputSchema
>;

export const writebackPayloadSchema = z
  .strictObject({
    adapterId: z.literal('hubspot_contact'),
    deliveryId: z.string().uuid(),
    occurredAt: z.iso.datetime(),
    properties: z
      .record(hubSpotPropertyNameSchema, z.string())
      .refine(
        (properties) => Object.keys(properties).length > 0,
        'A writeback needs at least one property.'
      ),
    recordId: z.string().trim().min(1).max(128),
    row: z.strictObject({
      id: z.string().uuid(),
      version: z.number().int().positive(),
    }),
    tableId: z.string().uuid(),
    version: z.literal(1),
    workspaceId: z.string().uuid(),
  })
  .refine(
    (payload) =>
      utf8ByteLength(JSON.stringify(payload)) <=
      MAXIMUM_WRITEBACK_PAYLOAD_BYTES,
    `Writeback payloads cannot exceed ${MAXIMUM_WRITEBACK_PAYLOAD_BYTES} bytes.`
  );

export type WritebackPayload = z.infer<typeof writebackPayloadSchema>;

const writebackCellStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'succeeded',
  'failed',
  'stale',
  'cancelled',
]);

export function shouldQueueWriteback(
  statuses: ReadonlyArray<z.infer<typeof writebackCellStatusSchema>>
): boolean {
  // CONTRIBUTOR DECISION POINT: HubSpot receives values without cell-status
  // metadata, so the safe default exports only input or successful cells.
  return statuses.every((status) => ['idle', 'succeeded'].includes(status));
}

export function hubSpotPropertyValue(value: CellValue): string {
  switch (value.type) {
    case 'empty':
      // HubSpot clears a property when its update value is an empty string.
      return '';
    case 'text':
    case 'timestamp':
      return value.value;
    case 'number':
      return String(value.value);
    case 'boolean':
      return value.value ? 'true' : 'false';
    case 'json':
      throw new TypeError('JSON cells cannot be mapped to HubSpot properties.');
  }
}

export function hubSpotRecordId(value: CellValue): string {
  const recordId = hubSpotPropertyValue(cellValueSchema.parse(value)).trim();
  if (!recordId || recordId.length > 128) {
    throw new TypeError('The HubSpot record ID is missing or too large.');
  }
  return recordId;
}

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
