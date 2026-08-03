import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildWebhookHeaders,
  classifyWebhookStatus,
} from './webhook-delivery-policy';

describe('webhook delivery policy', () => {
  it('signs the timestamp, delivery id, and exact body without exposing the secret', () => {
    const input = {
      body: '{"deliveryId":"20000000-0000-4000-8000-000000000002"}',
      deliveryId: '20000000-0000-4000-8000-000000000002',
      secret: 'YF3-yX7eJ4HfN5q9Lm2vR8uW1sK6cP0z7AaBbCc',
      timestamp: '1785528000',
    };
    const headers = buildWebhookHeaders(input);
    const expected = createHmac('sha256', input.secret)
      .update(`${input.timestamp}.${input.deliveryId}.${input.body}`)
      .digest('hex');

    expect(headers['x-byok-grid-signature']).toBe(`v1=${expected}`);
    expect(headers['idempotency-key']).toBe(input.deliveryId);
    expect(JSON.stringify(headers)).not.toContain(input.secret);
  });

  it.each([408, 425, 429, 500, 503, 599])(
    'retries transient HTTP %i responses',
    (status) => {
      expect(classifyWebhookStatus(status)).toMatchObject({
        responseStatus: status,
        retryable: true,
      });
    }
  );

  it.each([300, 301, 400, 401, 404, 410, 422])(
    'does not retry permanent HTTP %i responses',
    (status) => {
      expect(classifyWebhookStatus(status)).toMatchObject({
        responseStatus: status,
        retryable: false,
      });
    }
  );

  it('accepts all successful responses', () => {
    expect(classifyWebhookStatus(200)).toBeNull();
    expect(classifyWebhookStatus(204)).toBeNull();
  });
});
