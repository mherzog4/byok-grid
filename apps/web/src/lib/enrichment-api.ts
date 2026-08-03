import {
  BulkRunConflictError,
  EnrichmentAccessError,
  EnrichmentValidationError,
  ConnectorRevokedError,
  SqliteConnectorRevokedError,
  SqliteEnrichmentAccessError,
  SqliteEnrichmentConflictError,
  SqliteEnrichmentValidationError,
  SqliteBulkRunConflictError,
} from '@byok-grid/db';
import { unexpectedApiErrorResponse } from './request-correlation';

export function enrichmentErrorResponse(
  error: unknown,
  request: Request
): Response {
  if (
    error instanceof BulkRunConflictError ||
    error instanceof SqliteBulkRunConflictError ||
    error instanceof SqliteEnrichmentConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof EnrichmentAccessError ||
    error instanceof SqliteEnrichmentAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof EnrichmentValidationError ||
    error instanceof SqliteEnrichmentValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  if (
    error instanceof ConnectorRevokedError ||
    error instanceof SqliteConnectorRevokedError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  return unexpectedApiErrorResponse('enrichment', error, request);
}
