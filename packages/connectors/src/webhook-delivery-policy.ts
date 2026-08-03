import { createHmac } from 'node:crypto';

export class WebhookHttpError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable: boolean,
    public readonly responseStatus: number | null = null,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'WebhookHttpError';
  }
}

export function buildWebhookHeaders(input: {
  body: string;
  deliveryId: string;
  secret: string;
  timestamp: string;
}): Readonly<Record<string, string>> {
  const signedContent = `${input.timestamp}.${input.deliveryId}.${input.body}`;
  const signature = createHmac('sha256', input.secret)
    .update(signedContent, 'utf8')
    .digest('hex');
  return {
    'content-type': 'application/json',
    'idempotency-key': input.deliveryId,
    'user-agent': 'BYOK-Grid-Webhook/1.0',
    'x-byok-grid-delivery': input.deliveryId,
    'x-byok-grid-event': 'row.delivered',
    'x-byok-grid-signature': `v1=${signature}`,
    'x-byok-grid-timestamp': input.timestamp,
  };
}

export function classifyWebhookStatus(status: number): WebhookHttpError | null {
  if (status >= 200 && status < 300) return null;
  const retryable =
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599);
  return new WebhookHttpError(
    retryable ? 'upstream_retryable' : 'upstream_rejected',
    retryable
      ? `The webhook endpoint returned retryable HTTP ${status}.`
      : `The webhook endpoint rejected the delivery with HTTP ${status}.`,
    retryable,
    status
  );
}
