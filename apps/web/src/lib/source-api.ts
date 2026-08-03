import {
  SourceAccessError,
  SourceConflictError,
  SourceValidationError,
  SqliteSourceAccessError,
  SqliteSourceConflictError,
  SqliteSourceValidationError,
} from '@byok-grid/db';
import { unexpectedApiErrorResponse } from './request-correlation';

export function sourceErrorResponse(
  error: unknown,
  request: Request
): Response {
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
  return unexpectedApiErrorResponse('source', error, request);
}
