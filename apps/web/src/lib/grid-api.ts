import {
  GridAccessError,
  GridConflictError,
  GridValidationError,
  SqliteGridAccessError,
  SqliteGridConflictError,
  SqliteGridValidationError,
} from '@byok-grid/db';
import { getLocalOwner } from './local-owner';
import { unexpectedApiErrorResponse } from './request-correlation';

export async function getApiUser(request: Request) {
  void request;
  return getLocalOwner();
}

export function gridErrorResponse(error: unknown, request: Request): Response {
  if (
    error instanceof GridAccessError ||
    error instanceof SqliteGridAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof GridConflictError ||
    error instanceof SqliteGridConflictError
  ) {
    return Response.json(
      {
        error:
          error.message ||
          'This resource changed elsewhere. Refresh and try again.',
      },
      { status: 409 }
    );
  }
  if (
    error instanceof GridValidationError ||
    error instanceof SqliteGridValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  return unexpectedApiErrorResponse('grid', error, request);
}
