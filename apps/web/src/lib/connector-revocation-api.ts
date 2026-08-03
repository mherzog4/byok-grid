import {
  ConnectorRevocationAccessError,
  ConnectorRevocationConflictError,
  ConnectorRevocationValidationError,
  SqliteConnectorRevocationAccessError,
  SqliteConnectorRevocationConflictError,
  SqliteConnectorRevocationValidationError,
} from '@byok-grid/db';

export function connectorRevocationErrorResponse(error: unknown): Response {
  if (
    error instanceof ConnectorRevocationAccessError ||
    error instanceof SqliteConnectorRevocationAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof ConnectorRevocationConflictError ||
    error instanceof SqliteConnectorRevocationConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof ConnectorRevocationValidationError ||
    error instanceof SqliteConnectorRevocationValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  console.error('Unexpected connector revocation API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
