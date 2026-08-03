import {
  SourceAccessError,
  SourceConflictError,
  SourceValidationError,
  SqliteSourceAccessError,
  SqliteSourceConflictError,
  SqliteSourceValidationError,
} from '@byok-grid/db';

export function sourceErrorResponse(error: unknown): Response {
  if (
    error instanceof SourceAccessError ||
    error instanceof SqliteSourceAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof SourceConflictError ||
    error instanceof SqliteSourceConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof SourceValidationError ||
    error instanceof SqliteSourceValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  console.error('Unexpected source API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
