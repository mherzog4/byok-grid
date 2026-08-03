import {
  WebhookAccessError,
  WebhookConflictError,
  WebhookValidationError,
  SqliteWebhookAccessError,
  SqliteWebhookConflictError,
  SqliteWebhookValidationError,
} from '@byok-grid/db';

export function webhookErrorResponse(error: unknown): Response {
  if (
    error instanceof WebhookAccessError ||
    error instanceof SqliteWebhookAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof WebhookConflictError ||
    error instanceof SqliteWebhookConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof WebhookValidationError ||
    error instanceof SqliteWebhookValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  console.error('Unexpected webhook API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
