import {
  WritebackAccessError,
  WritebackConflictError,
  WritebackValidationError,
  SqliteWritebackAccessError,
  SqliteWritebackConflictError,
  SqliteWritebackValidationError,
} from '@byok-grid/db';
import { unexpectedApiErrorResponse } from './request-correlation';

export function writebackErrorResponse(
  error: unknown,
  request: Request
): Response {
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
  return unexpectedApiErrorResponse('writeback', error, request);
}
