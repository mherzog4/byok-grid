import {
  SqliteWorkflowAccessError,
  SqliteWorkflowConflictError,
  SqliteWorkflowRunAccessError,
  SqliteWorkflowRunConflictError,
  SqliteWorkflowRunValidationError,
} from '@byok-grid/db';
import { z } from 'zod';
import { unexpectedApiErrorResponse } from './request-correlation';

export function workflowErrorResponse(
  error: unknown,
  request: Request
): Response {
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
  return unexpectedApiErrorResponse('workflow', error, request);
}
