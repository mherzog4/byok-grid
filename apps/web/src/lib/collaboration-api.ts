import {
  CollaborationAccessError,
  CollaborationConflictError,
  CollaborationValidationError,
  SqliteCollaborationAccessError,
  SqliteCollaborationConflictError,
  SqliteCollaborationValidationError,
} from '@byok-grid/db';

export function collaborationErrorResponse(error: unknown): Response {
  if (
    error instanceof CollaborationAccessError ||
    error instanceof SqliteCollaborationAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof CollaborationConflictError ||
    error instanceof SqliteCollaborationConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof CollaborationValidationError ||
    error instanceof SqliteCollaborationValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  console.error('Unexpected collaboration API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
