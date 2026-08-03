import { createHmac } from 'node:crypto';
import {
  CONNECTOR_SANDBOX_PROTOCOL_VERSION,
  ConnectorError,
  type ConnectorHostPolicy,
  type ConnectorJsonValue,
  type SandboxConnectorInvocation,
  sandboxConnectorResultSchema,
} from '@byok-grid/connector-sdk';
import { sandboxJsonSchemaMatches } from './sandbox-schema';

const MAXIMUM_RPC_BYTES = 1_048_576;
const MAXIMUM_UPSTREAM_BYTES = 1_048_576;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface SandboxRunnerClientConfig {
  sharedSecret: string;
  url: string;
}

export interface SandboxConnectorExecution {
  actionId: string;
  connectorId: string;
  connectorVersion: string;
  credential: Readonly<Record<string, ConnectorJsonValue>>;
  credentialSchema: Readonly<Record<string, unknown>>;
  hostPolicy: ConnectorHostPolicy;
  input: ConnectorJsonValue;
  inputSchema: Readonly<Record<string, unknown>>;
  outputSchema: Readonly<Record<string, unknown>>;
  runId: string;
}

export function sandboxEffectBudget(_execution: SandboxConnectorExecution) {
  return 4;
}

export async function executeSandboxConnector(
  execution: SandboxConnectorExecution,
  runner: SandboxRunnerClientConfig,
  dependencies: {
    egressFetch?: typeof globalThis.fetch;
    runnerFetch?: typeof globalThis.fetch;
  } = {}
): Promise<ConnectorJsonValue> {
  if (execution.hostPolicy.kind !== 'fixed') {
    throw new ConnectorError(
      'policy',
      'Sandbox connectors must declare fixed egress hosts.',
      false
    );
  }
  if (
    !sandboxJsonSchemaMatches(execution.credentialSchema, execution.credential)
  ) {
    throw new ConnectorError(
      'authentication',
      'The stored sandbox connector credential is invalid.',
      false
    );
  }
  if (!sandboxJsonSchemaMatches(execution.inputSchema, execution.input)) {
    throw new ConnectorError(
      'invalid_input',
      'The sandbox connector input does not match its installed schema.',
      false
    );
  }

  const allowedHosts = new Set(
    execution.hostPolicy.hosts.map((host) => host.toLowerCase())
  );
  const egressFetch = dependencies.egressFetch ?? globalThis.fetch;
  let continuation: SandboxConnectorInvocation['continuation'] = null;
  const effectBudget = sandboxEffectBudget(execution);

  for (let stepNumber = 0; stepNumber <= effectBudget; stepNumber += 1) {
    const result = await invokeRunner(
      {
        actionId: execution.actionId,
        connectorId: execution.connectorId,
        connectorVersion: execution.connectorVersion,
        continuation,
        credential: execution.credential,
        input: execution.input,
        protocolVersion: CONNECTOR_SANDBOX_PROTOCOL_VERSION,
        runId: execution.runId,
      },
      runner,
      dependencies.runnerFetch ?? globalThis.fetch
    );

    if (result.step.kind === 'complete') {
      if (
        !sandboxJsonSchemaMatches(execution.outputSchema, result.step.output)
      ) {
        throw new ConnectorError(
          'upstream',
          'The sandbox connector output does not match its installed schema.',
          false
        );
      }
      return result.step.output;
    }
    if (result.step.kind === 'failure') {
      throw new ConnectorError(
        result.step.code,
        result.step.message,
        result.step.retryable
      );
    }
    if (stepNumber === effectBudget) {
      throw new ConnectorError(
        'policy',
        'The sandbox connector exceeded its HTTP effect budget.',
        false
      );
    }

    const requestUrl = validateEffectUrl(result.step.request.url, allowedHosts);
    const headers = sanitizeRequestHeaders(result.step.request.headers);
    const body = decodeBase64Body(result.step.request.bodyBase64);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await egressFetch(requestUrl, {
        body,
        headers,
        method: result.step.request.method,
        redirect: 'error',
        signal: controller.signal,
      });
      const responseBytes = await readBodyWithinLimit(
        response,
        MAXIMUM_UPSTREAM_BYTES
      );
      continuation = {
        response: {
          bodyBase64: Buffer.from(responseBytes).toString('base64'),
          headers: sanitizeResponseHeaders(response.headers),
          status: response.status,
        },
        state: result.step.state,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new ConnectorError(
    'policy',
    'The sandbox connector did not finish.',
    false
  );
}

export function signSandboxRunnerRequest(
  secret: string,
  timestamp: number,
  body: string
): string {
  return createHmac('sha256', secret)
    .update(`v1:${timestamp}:`)
    .update(body)
    .digest('hex');
}

async function invokeRunner(
  invocation: SandboxConnectorInvocation,
  runner: SandboxRunnerClientConfig,
  runnerFetch: typeof globalThis.fetch
) {
  const body = JSON.stringify(invocation);
  if (Buffer.byteLength(body) > MAXIMUM_RPC_BYTES) {
    throw new ConnectorError(
      'invalid_input',
      'The sandbox connector invocation is too large.',
      false
    );
  }
  const timestamp = Math.floor(Date.now() / 1_000);
  let response: Response;
  try {
    response = await runnerFetch(new URL('/v1/execute', runner.url), {
      body,
      headers: {
        'content-type': 'application/json',
        'x-byok-grid-signature': signSandboxRunnerRequest(
          runner.sharedSecret,
          timestamp,
          body
        ),
        'x-byok-grid-timestamp': String(timestamp),
      },
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new ConnectorError(
      'transient',
      'The sandbox connector runner is unavailable.',
      true,
      { cause: error }
    );
  }
  if (!response.ok) {
    throw new ConnectorError(
      response.status >= 500 ? 'transient' : 'policy',
      'The sandbox connector runner rejected the invocation.',
      response.status >= 500
    );
  }
  const bytes = await readBodyWithinLimit(response, MAXIMUM_RPC_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new ConnectorError(
      'upstream',
      'The sandbox connector returned invalid JSON.',
      false,
      { cause: error }
    );
  }
  const parsed = sandboxConnectorResultSchema.safeParse(value);
  if (!parsed.success) {
    throw new ConnectorError(
      'upstream',
      'The sandbox connector returned an invalid protocol result.',
      false,
      { cause: parsed.error }
    );
  }
  return parsed.data;
}

function validateEffectUrl(
  urlValue: string,
  allowedHosts: ReadonlySet<string>
) {
  const url = new URL(urlValue);
  if (
    url.protocol !== 'https:' ||
    Boolean(url.username || url.password) ||
    (url.port !== '' && url.port !== '443') ||
    !allowedHosts.has(url.hostname.toLowerCase())
  ) {
    throw new ConnectorError(
      'policy',
      'The sandbox connector requested a URL outside its fixed host policy.',
      false
    );
  }
  return url;
}

function sanitizeRequestHeaders(input: Record<string, string>): Headers {
  const headers = new Headers();
  let totalBytes = 0;
  for (const [name, value] of Object.entries(input)) {
    const normalized = name.toLowerCase();
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (
      FORBIDDEN_REQUEST_HEADERS.has(normalized) ||
      normalized.startsWith('proxy-') ||
      totalBytes > 32_768
    ) {
      throw new ConnectorError(
        'policy',
        'The sandbox connector requested forbidden HTTP headers.',
        false
      );
    }
    headers.set(name, value);
  }
  return headers;
}

function sanitizeResponseHeaders(input: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  let totalBytes = 0;
  for (const [name, value] of input) {
    if (name.toLowerCase() === 'set-cookie') continue;
    totalBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    if (totalBytes > 32_768) break;
    output[name] = value.slice(0, 8_192);
  }
  return output;
}

function decodeBase64Body(value: string | null): BodyInit | null {
  if (value === null) return null;
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new ConnectorError(
      'invalid_input',
      'The sandbox connector returned an invalid request body.',
      false
    );
  }
  const body = Buffer.from(value, 'base64');
  if (body.byteLength > MAXIMUM_UPSTREAM_BYTES) {
    throw new ConnectorError(
      'response_too_large',
      'The sandbox connector request body is too large.',
      false
    );
  }
  return body;
}

async function readBodyWithinLimit(
  response: Response,
  maximumBytes: number
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new ConnectorError(
      'response_too_large',
      'The connector response is too large.',
      false
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new ConnectorError(
        'response_too_large',
        'The connector response is too large.',
        false
      );
    }
    chunks.push(value);
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
