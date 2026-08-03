import {
  WorkspacePurgeAccessError,
  WorkspacePurgeConflictError,
  WorkspacePurgeValidationError,
  SqliteWorkspacePurgeAccessError,
  SqliteWorkspacePurgeConflictError,
  SqliteWorkspacePurgeValidationError,
} from '@byok-grid/db';

export function workspacePurgeErrorResponse(error: unknown): Response {
  if (
    error instanceof WorkspacePurgeAccessError ||
    error instanceof SqliteWorkspacePurgeAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof WorkspacePurgeConflictError ||
    error instanceof SqliteWorkspacePurgeConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof WorkspacePurgeValidationError ||
    error instanceof SqliteWorkspacePurgeValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  console.error('Unexpected workspace purge API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
