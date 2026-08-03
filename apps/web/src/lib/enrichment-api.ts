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

export function enrichmentErrorResponse(error: unknown): Response {
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
  console.error('Unexpected enrichment API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
