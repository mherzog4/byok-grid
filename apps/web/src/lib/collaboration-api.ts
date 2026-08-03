import {
  CollaborationAccessError,
  CollaborationConflictError,
  CollaborationValidationError,
  SqliteCollaborationAccessError,
  SqliteCollaborationConflictError,
  SqliteCollaborationValidationError,
} from '@byok-grid/db';
import { unexpectedApiErrorResponse } from './request-correlation';

export function collaborationErrorResponse(
  error: unknown,
  request: Request
): Response {
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
  return unexpectedApiErrorResponse('collaboration', error, request);
}
