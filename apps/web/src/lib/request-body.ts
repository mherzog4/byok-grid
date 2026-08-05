export const MAXIMUM_API_JSON_BODY_BYTES = 5 * 1_048_576;

/**
 * Reads JSON incrementally so App Router handlers never buffer an unbounded
 * request before their domain schema runs. Invalid JSON remains `null` to
 * preserve each route's existing validation response; only transport-level
 * size failures produce a shared response.
 */
export async function readApiJsonBody(
  request: Request,
  maximumBytes = MAXIMUM_API_JSON_BODY_BYTES
): Promise<unknown | Response> {
  const result = await readBoundedBodyBytes(request, maximumBytes);
  if (result instanceof Response) return result;
  if (result.byteLength === 0) return null;

  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(result)
    ) as unknown;
  } catch {
    return null;
  }
}

async function readBoundedBodyBytes(
  request: Request,
  maximumBytes: number
): Promise<Uint8Array | Response> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error('The API JSON body limit must be a positive safe integer.');
  }

  const contentEncoding = request.headers.get('content-encoding');
  if (contentEncoding && contentEncoding.toLowerCase() !== 'identity') {
    await request.body?.cancel().catch(() => undefined);
    return unsupportedEncodingResponse();
  }

  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^[0-9]+$/.test(declaredLength)) {
      await request.body?.cancel().catch(() => undefined);
      return invalidLengthResponse();
    }
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength)) {
      await request.body?.cancel().catch(() => undefined);
      return invalidLengthResponse();
    }
    if (parsedLength > maximumBytes) {
      await request.body?.cancel().catch(() => undefined);
      return tooLargeResponse(maximumBytes);
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return tooLargeResponse(maximumBytes);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function tooLargeResponse(maximumBytes: number): Response {
  return Response.json(
    {
      error: `The request body exceeds ${formatByteLimit(maximumBytes)}.`,
    },
    {
      headers: { 'cache-control': 'no-store' },
      status: 413,
    }
  );
}

function invalidLengthResponse(): Response {
  return Response.json(
    { error: 'The Content-Length header is invalid.' },
    {
      headers: { 'cache-control': 'no-store' },
      status: 400,
    }
  );
}

function unsupportedEncodingResponse(): Response {
  return Response.json(
    { error: 'Compressed API request bodies are not supported.' },
    {
      headers: { 'cache-control': 'no-store' },
      status: 415,
    }
  );
}

function formatByteLimit(bytes: number): string {
  if (bytes % 1_048_576 === 0) return `${bytes / 1_048_576} MiB`;
  if (bytes % 1_024 === 0) return `${bytes / 1_024} KiB`;
  return `${bytes} bytes`;
}
