import {
  CredentialAccessError,
  CredentialValidationError,
  SqliteCredentialAccessError,
  SqliteCredentialValidationError,
} from '@byok-grid/db';
import { unexpectedApiErrorResponse } from './request-correlation';

export function credentialErrorResponse(
  error: unknown,
  request: Request
): Response {
  if (
    error instanceof CredentialAccessError ||
    error instanceof SqliteCredentialAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof CredentialValidationError ||
    error instanceof SqliteCredentialValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  return unexpectedApiErrorResponse('credential', error, request);
}
