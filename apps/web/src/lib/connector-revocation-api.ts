import {
  ConnectorRevocationAccessError,
  ConnectorRevocationConflictError,
  ConnectorRevocationValidationError,
  SqliteConnectorRevocationAccessError,
  SqliteConnectorRevocationConflictError,
  SqliteConnectorRevocationValidationError,
} from '@byok-grid/db';
import { unexpectedApiErrorResponse } from './request-correlation';

export function connectorRevocationErrorResponse(
  error: unknown,
  request: Request
): Response {
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
  return unexpectedApiErrorResponse('connector-revocation', error, request);
}
