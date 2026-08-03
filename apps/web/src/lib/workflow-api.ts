import {
  SqliteWorkflowAccessError,
  SqliteWorkflowConflictError,
  SqliteWorkflowRunAccessError,
  SqliteWorkflowRunConflictError,
  SqliteWorkflowRunValidationError,
} from '@byok-grid/db';
import { z } from 'zod';

export function workflowErrorResponse(error: unknown): Response {
  if (
    error instanceof SqliteWorkflowAccessError ||
    error instanceof SqliteWorkflowRunAccessError
  ) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (
    error instanceof SqliteWorkflowConflictError ||
    error instanceof SqliteWorkflowRunConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof SqliteWorkflowRunValidationError ||
    error instanceof z.ZodError
  ) {
    return Response.json(
      {
        error:
          error instanceof z.ZodError
            ? (error.issues[0]?.message ?? 'The workflow is invalid.')
            : error.message,
      },
      { status: 422 }
    );
  }
  console.error('Unexpected workflow API error', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  return Response.json({ error: 'The request failed.' }, { status: 500 });
}
