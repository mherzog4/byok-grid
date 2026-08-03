import { z } from 'zod';
import { cellValueSchema } from './cell-values';
import { vaultSafeHttpsUrlSchema } from './endpoint-policy';

export const MAXIMUM_WEBHOOK_PAYLOAD_BYTES = 512 * 1_024;

export const webhookTriggerModeSchema = z.enum(['manual', 'row_settled']);
export type WebhookTriggerMode = z.infer<typeof webhookTriggerModeSchema>;

export const webhookDestinationRequestSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  signingCredentialId: z.string().uuid(),
  triggerMode: webhookTriggerModeSchema.default('manual'),
  url: vaultSafeHttpsUrlSchema('Webhook'),
});

export type WebhookDestinationRequest = z.infer<
  typeof webhookDestinationRequestSchema
>;
export type WebhookDestinationRequestInput = z.input<
  typeof webhookDestinationRequestSchema
>;

export const webhookDestinationUpdateSchema = z
  .strictObject({
    status: z.enum(['active', 'paused']).optional(),
    triggerMode: webhookTriggerModeSchema.optional(),
  })
  .refine(
    (update) => update.status !== undefined || update.triggerMode !== undefined,
    'At least one webhook destination setting is required.'
  );

export type WebhookDestinationUpdate = z.infer<
  typeof webhookDestinationUpdateSchema
>;

export const webhookDeliveryRequestSchema = z.strictObject({
  deliveryId: z.string().uuid(),
});

export const webhookDeliveryInputSchema = z.strictObject({
  deliveryId: z.string().uuid(),
  destinationId: z.string().uuid(),
  tableId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

export type WebhookDeliveryInput = z.infer<typeof webhookDeliveryInputSchema>;

export const rowSettlementInputSchema = z.strictObject({
  rowId: z.string().uuid(),
  rowVersion: z.number().int().positive(),
  settlementId: z.string().uuid(),
  tableId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});

export type RowSettlementInput = z.infer<typeof rowSettlementInputSchema>;

const webhookCellSchema = z.strictObject({
  columnId: z.string().uuid(),
  name: z.string().min(1).max(120),
  status: z.enum([
    'idle',
    'queued',
    'running',
    'succeeded',
    'failed',
    'stale',
    'cancelled',
  ]),
  value: cellValueSchema,
});

export const webhookPayloadSchema = z
  .strictObject({
    data: z.strictObject({
      row: z.strictObject({
        cells: z.array(webhookCellSchema).max(500),
        id: z.string().uuid(),
        version: z.number().int().positive(),
      }),
      table: z.strictObject({
        id: z.string().uuid(),
        name: z.string().min(1).max(120),
      }),
    }),
    deliveryId: z.string().uuid(),
    event: z.literal('row.delivered'),
    occurredAt: z.iso.datetime(),
    trigger: z.strictObject({
      mode: webhookTriggerModeSchema,
      rowVersion: z.number().int().positive(),
    }),
    version: z.literal(1),
    workspaceId: z.string().uuid(),
  })
  .refine(
    (payload) =>
      utf8ByteLength(JSON.stringify(payload)) <= MAXIMUM_WEBHOOK_PAYLOAD_BYTES,
    `Webhook payloads cannot exceed ${MAXIMUM_WEBHOOK_PAYLOAD_BYTES} bytes.`
  );

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

export function shouldDeliverSettledRow(
  statuses: ReadonlyArray<z.infer<typeof webhookCellSchema>['status']>
): boolean {
  // CONTRIBUTOR DECISION POINT: the default treats failed and cancelled cells
  // as settled so receivers can inspect partial results. A stricter product can
  // require every computed cell to succeed before automatic delivery.
  return statuses.every(
    (status) => status !== 'queued' && status !== 'running'
  );
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
