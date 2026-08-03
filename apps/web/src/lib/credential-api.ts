import {
  CredentialAccessError,
  CredentialValidationError,
  SqliteCredentialAccessError,
  SqliteCredentialValidationError,
} from '@byok-grid/db';

export function credentialErrorResponse(error: unknown): Response {
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
  console.error('Unexpected credential API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
