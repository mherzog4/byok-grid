import type {
  DestinationRoute,
  DestinationRuntime,
  JsonObject,
} from './types.js';

const maximumResponseBytes = 64 * 1_024;
const requestAttempts = 3;

export class AirbyteDestinationRequestError extends Error {}

export interface EndpointCapability {
  endpointId: string;
  maximumBodyBytes: number;
  maximumRecords: number;
  recordKeyField: string;
  status: 'active';
}

export async function checkEndpoint(
  route: DestinationRoute,
  runtime: DestinationRuntime
): Promise<EndpointCapability> {
  const response = await guardedFetch(route, runtime, route.endpointUrl, {
    method: 'GET',
  });
  if (response.status !== 200) {
    throw new AirbyteDestinationRequestError(
      `Endpoint check failed with HTTP ${response.status}.`
    );
  }
  const capability = await readJsonObject(response);
  const endpointId = endpointIdFromUrl(route.endpointUrl);
  if (
    capability.endpointId !== endpointId ||
    capability.status !== 'active' ||
    typeof capability.recordKeyField !== 'string' ||
    capability.recordKeyField.length === 0 ||
    capability.recordKeyField.length > 120 ||
    /\p{Cc}/u.test(capability.recordKeyField) ||
    typeof capability.maximumRecords !== 'number' ||
    !Number.isInteger(capability.maximumRecords) ||
    capability.maximumRecords < 1 ||
    typeof capability.maximumBodyBytes !== 'number' ||
    !Number.isInteger(capability.maximumBodyBytes) ||
    capability.maximumBodyBytes < 1
  ) {
    throw new AirbyteDestinationRequestError(
      'Endpoint check returned an invalid capability document.'
    );
  }
  return capability as unknown as EndpointCapability;
}

export async function submitBatch(
  route: DestinationRoute,
  runtime: DestinationRuntime,
  input: {
    body: string;
    idempotencyKey: string;
    timeoutSeconds: number;
  }
): Promise<void> {
  const response = await guardedFetch(route, runtime, route.endpointUrl, {
    body: input.body,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': input.idempotencyKey,
    },
    method: 'POST',
  });
  if (response.status !== 202) {
    throw new AirbyteDestinationRequestError(
      `Batch submission failed with HTTP ${response.status}.`
    );
  }
  const accepted = await readJsonObject(response);
  if (
    typeof accepted.id !== 'string' ||
    !['queued', 'running', 'succeeded'].includes(String(accepted.status))
  ) {
    throw new AirbyteDestinationRequestError(
      'Batch submission returned an invalid acceptance document.'
    );
  }
  const statusUrl = validateStatusLocation(
    route.endpointUrl,
    response.headers.get('location'),
    accepted.id
  );
  await waitForApplication(route, runtime, statusUrl, input.timeoutSeconds);
}

async function waitForApplication(
  route: DestinationRoute,
  runtime: DestinationRuntime,
  statusUrl: string,
  timeoutSeconds: number
): Promise<void> {
  const deadline = runtime.now() + timeoutSeconds * 1_000;
  for (;;) {
    const response = await guardedFetch(route, runtime, statusUrl, {
      method: 'GET',
    });
    if (response.status !== 200) {
      throw new AirbyteDestinationRequestError(
        `Batch status failed with HTTP ${response.status}.`
      );
    }
    const status = await readJsonObject(response);
    if (status.status === 'succeeded') return;
    if (status.status === 'failed' || status.status === 'cancelled') {
      const detail =
        typeof status.errorMessage === 'string'
          ? `: ${safeDetail(status.errorMessage)}`
          : '';
      throw new AirbyteDestinationRequestError(
        `BYOK Grid batch ${String(status.status)}${detail}`
      );
    }
    if (status.status !== 'queued' && status.status !== 'running') {
      throw new AirbyteDestinationRequestError(
        'Batch status returned an unknown state.'
      );
    }
    if (runtime.now() >= deadline) {
      throw new AirbyteDestinationRequestError(
        `BYOK Grid did not apply the batch within ${timeoutSeconds} seconds.`
      );
    }
    await runtime.sleep(1_000);
  }
}

async function guardedFetch(
  route: DestinationRoute,
  runtime: DestinationRuntime,
  url: string,
  init: RequestInit
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= requestAttempts; attempt += 1) {
    try {
      const response = await runtime.fetch(url, {
        ...init,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${route.bearerToken}`,
          'user-agent': 'byok-grid-airbyte-destination/0.1.0',
          ...(init.headers ?? {}),
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status >= 300 && response.status < 400) {
        throw new AirbyteDestinationRequestError(
          'BYOK Grid endpoints must not redirect.'
        );
      }
      if (response.status !== 429 && response.status < 500) return response;
      lastError = new AirbyteDestinationRequestError(
        `BYOK Grid returned retryable HTTP ${response.status}.`
      );
      await response.body?.cancel();
      if (attempt < requestAttempts) {
        await runtime.sleep(retryDelay(response, attempt));
      }
    } catch (error) {
      lastError = error;
      if (error instanceof AirbyteDestinationRequestError) throw error;
      if (attempt < requestAttempts) await runtime.sleep(attempt * 500);
    }
  }
  throw new AirbyteDestinationRequestError(
    'BYOK Grid could not be reached after three attempts.',
    { cause: lastError }
  );
}

async function readJsonObject(response: Response): Promise<JsonObject> {
  const bytes = await readBoundedResponse(response);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AirbyteDestinationRequestError(
      'BYOK Grid returned invalid JSON.'
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AirbyteDestinationRequestError(
      'BYOK Grid returned an invalid JSON document.'
    );
  }
  return value as JsonObject;
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > maximumResponseBytes
  ) {
    await response.body?.cancel();
    throw new AirbyteDestinationRequestError(
      'BYOK Grid returned an oversized response.'
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumResponseBytes) {
      await reader.cancel();
      throw new AirbyteDestinationRequestError(
        'BYOK Grid returned an oversized response.'
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function validateStatusLocation(
  endpointUrl: string,
  location: string | null,
  batchId: string
): string {
  if (!location) {
    throw new AirbyteDestinationRequestError(
      'Batch acceptance did not include a status location.'
    );
  }
  const endpoint = new URL(endpointUrl);
  const status = new URL(location, endpoint);
  const expectedPath = `${endpoint.pathname}/batches/${batchId}`;
  if (
    status.origin !== endpoint.origin ||
    status.pathname !== expectedPath ||
    status.search ||
    status.hash ||
    status.username ||
    status.password
  ) {
    throw new AirbyteDestinationRequestError(
      'Batch acceptance returned an unsafe status location.'
    );
  }
  return status.toString();
}

function endpointIdFromUrl(endpointUrl: string): string {
  return new URL(endpointUrl).pathname.split('/').at(-1)!;
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get('retry-after'));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1_000, 10_000)
    : attempt * 500;
}

function safeDetail(value: string): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, 300);
}
