export const INTERNAL_REQUEST_ID_HEADER = 'x-byok-grid-request-id';
export const PUBLIC_REQUEST_ID_HEADER = 'x-request-id';

const requestIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safeErrorNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;

export type UnexpectedApiArea =
  | 'collaboration'
  | 'connector-revocation'
  | 'credential'
  | 'csv-import'
  | 'enrichment'
  | 'formula'
  | 'grid'
  | 'ingestion'
  | 'source'
  | 'webhook'
  | 'workflow'
  | 'workspace-purge'
  | 'writeback';

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function requestIdFromRequest(request: Request): string | undefined {
  const value = request.headers.get(INTERNAL_REQUEST_ID_HEADER);
  return value && requestIdPattern.test(value) ? value : undefined;
}

export function unexpectedApiErrorResponse(
  area: UnexpectedApiArea,
  error: unknown,
  request: Request
): Response {
  const requestId = requestIdFromRequest(request) ?? createRequestId();
  console.error(
    JSON.stringify({
      area,
      errorName: safeErrorName(error),
      event: 'api.unexpected_error',
      requestId,
    })
  );
  return Response.json(
    { error: 'The request failed.', requestId },
    {
      headers: { [PUBLIC_REQUEST_ID_HEADER]: requestId },
      status: 500,
    }
  );
}

function safeErrorName(error: unknown): string {
  try {
    if (!(error instanceof Error)) return 'UnknownError';
    return safeErrorNamePattern.test(error.name) ? error.name : 'Error';
  } catch {
    return 'Error';
  }
}
