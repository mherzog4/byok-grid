import {
  IngestionAccessError,
  IngestionConflictError,
  IngestionValidationError,
  SqliteIngestionAccessError,
  SqliteIngestionConflictError,
  SqliteIngestionValidationError,
} from '@byok-grid/db';
import { MAXIMUM_INGESTION_BODY_BYTES } from '@byok-grid/domain';
import { unexpectedApiErrorResponse } from './request-correlation';

export class IngestionBodyTooLargeError extends Error {}

export function readIngestionBearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization');
  const token = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : '';
  return /^bg_ingest_[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

export async function readBoundedJsonBody(request: Request): Promise<{
  body: unknown;
  bytes: Uint8Array;
}> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > MAXIMUM_INGESTION_BODY_BYTES
  ) {
    throw new IngestionBodyTooLargeError('The request body exceeds 5 MiB.');
  }
  if (!request.body)
    throw new IngestionValidationError('A JSON body is required.');

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAXIMUM_INGESTION_BODY_BYTES) {
      await reader.cancel();
      throw new IngestionBodyTooLargeError('The request body exceeds 5 MiB.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      body: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      bytes,
    };
  } catch {
    throw new IngestionValidationError('The request body is not valid JSON.');
  }
}

export function ingestionErrorResponse(
  error: unknown,
  request: Request
): Response {
  if (error instanceof IngestionBodyTooLargeError) {
    return Response.json({ error: error.message }, { status: 413 });
  }
  if (
    error instanceof IngestionAccessError ||
    error instanceof SqliteIngestionAccessError
  ) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }
  if (
    error instanceof IngestionConflictError ||
    error instanceof SqliteIngestionConflictError
  ) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (
    error instanceof IngestionValidationError ||
    error instanceof SqliteIngestionValidationError
  ) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  return unexpectedApiErrorResponse('ingestion', error, request);
}
