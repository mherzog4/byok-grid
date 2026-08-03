import {
  WorkspacePurgeAccessError,
  WorkspacePurgeConflictError,
  WorkspacePurgeValidationError,
  SqliteWorkspacePurgeAccessError,
  SqliteWorkspacePurgeConflictError,
  SqliteWorkspacePurgeValidationError,
} from '@byok-grid/db';
import { unexpectedApiErrorResponse } from './request-correlation';

export function workspacePurgeErrorResponse(
  error: unknown,
  request: Request
): Response {
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
  return unexpectedApiErrorResponse('workspace-purge', error, request);
}
