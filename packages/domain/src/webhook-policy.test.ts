import { describe, expect, it } from 'vitest';
import {
  MAXIMUM_WEBHOOK_PAYLOAD_BYTES,
  shouldDeliverSettledRow,
  webhookDestinationRequestSchema,
  webhookDestinationUpdateSchema,
  webhookPayloadSchema,
} from './webhook-policy';

const signingCredentialId = '10000000-0000-4000-8000-000000000001';
const deliveryId = '20000000-0000-4000-8000-000000000002';
const workspaceId = '30000000-0000-4000-8000-000000000003';
const tableId = '40000000-0000-4000-8000-000000000004';
const rowId = '50000000-0000-4000-8000-000000000005';
const columnId = '60000000-0000-4000-8000-000000000006';

describe('webhook policy', () => {
  it('accepts a vault-backed HTTPS destination', () => {
    expect(
      webhookDestinationRequestSchema.parse({
        name: 'CRM intake',
        signingCredentialId,
        url: 'https://hooks.example.com/enriched-rows?environment=production',
      })
    ).toEqual({
      name: 'CRM intake',
      signingCredentialId,
      triggerMode: 'manual',
      url: 'https://hooks.example.com/enriched-rows?environment=production',
    });
  });

  it('accepts explicit automatic delivery and rejects empty updates', () => {
    expect(
      webhookDestinationRequestSchema.parse({
        name: 'CRM intake',
        signingCredentialId,
        triggerMode: 'row_settled',
        url: 'https://hooks.example.com/enriched-rows',
      }).triggerMode
    ).toBe('row_settled');
    expect(webhookDestinationUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      webhookDestinationUpdateSchema.parse({ triggerMode: 'manual' })
    ).toEqual({ triggerMode: 'manual' });
  });

  it('settles only after every active cell run reaches a terminal state', () => {
    expect(shouldDeliverSettledRow(['idle', 'succeeded', 'failed'])).toBe(true);
    expect(shouldDeliverSettledRow(['succeeded', 'cancelled'])).toBe(true);
    expect(shouldDeliverSettledRow(['succeeded', 'queued'])).toBe(false);
    expect(shouldDeliverSettledRow(['running', 'failed'])).toBe(false);
  });

  it.each([
    'http://hooks.example.com/rows',
    'https://user:password@hooks.example.com/rows',
    'https://hooks.example.com/rows?api_key=plaintext',
    'https://hooks.example.com/rows?%74oken=plaintext',
    'https://hooks.example.com/rows#fragment',
  ])('rejects unsafe endpoint configuration: %s', (url) => {
    expect(
      webhookDestinationRequestSchema.safeParse({
        name: 'Unsafe',
        signingCredentialId,
        url,
      }).success
    ).toBe(false);
  });

  it('accepts a typed deterministic row snapshot', () => {
    const payload = webhookPayloadSchema.parse({
      data: {
        row: {
          cells: [
            {
              columnId,
              name: 'Company',
              status: 'idle',
              value: { type: 'text', value: 'Acme' },
            },
          ],
          id: rowId,
          version: 2,
        },
        table: { id: tableId, name: 'Companies' },
      },
      deliveryId,
      event: 'row.delivered',
      occurredAt: '2026-07-31T12:00:00.000Z',
      trigger: { mode: 'row_settled', rowVersion: 2 },
      version: 1,
      workspaceId,
    });

    expect(payload.data.row.cells[0]?.value).toEqual({
      type: 'text',
      value: 'Acme',
    });
  });

  it('rejects snapshots beyond the delivery body limit', () => {
    const parsed = webhookPayloadSchema.safeParse({
      data: {
        row: {
          cells: [
            {
              columnId,
              name: 'Oversized',
              status: 'idle',
              value: {
                type: 'text',
                value: 'x'.repeat(MAXIMUM_WEBHOOK_PAYLOAD_BYTES),
              },
            },
          ],
          id: rowId,
          version: 1,
        },
        table: { id: tableId, name: 'Companies' },
      },
      deliveryId,
      event: 'row.delivered',
      occurredAt: '2026-07-31T12:00:00.000Z',
      trigger: { mode: 'manual', rowVersion: 1 },
      version: 1,
      workspaceId,
    });

    expect(parsed.success).toBe(false);
  });
});
