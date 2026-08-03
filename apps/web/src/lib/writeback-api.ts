import {
  WritebackAccessError,
  WritebackConflictError,
  WritebackValidationError,
  SqliteWritebackAccessError,
  SqliteWritebackConflictError,
  SqliteWritebackValidationError,
} from '@byok-grid/db';

export function writebackErrorResponse(error: unknown): Response {
  if (
    error instanceof WritebackAccessError ||
    error instanceof SqliteWritebackAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof WritebackConflictError ||
    error instanceof SqliteWritebackConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof WritebackValidationError ||
    error instanceof SqliteWritebackValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  console.error('Unexpected writeback API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
