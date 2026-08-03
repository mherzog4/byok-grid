import {
  GridAccessError,
  GridConflictError,
  GridValidationError,
  SqliteGridAccessError,
  SqliteGridConflictError,
  SqliteGridValidationError,
} from '@byok-grid/db';
import { auth } from './auth';

export async function getApiUser(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  return session?.user ?? null;
}

export function gridErrorResponse(error: unknown): Response {
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
  console.error('Unexpected grid API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
