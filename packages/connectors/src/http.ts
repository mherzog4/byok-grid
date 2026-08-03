import { z } from 'zod';
import {
  CONNECTOR_PROTOCOL_VERSION,
  ConnectorError,
  defineConnector,
  type ConnectorAction,
  type ConnectorDefinition,
} from '@byok-grid/connector-sdk';

export const httpCredentialSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), token: z.string().min(1) }),
  z.object({
    type: z.literal('apiKeyHeader'),
    headerName: z.string().regex(/^[A-Za-z0-9-]+$/),
    value: z.string().min(1),
  }),
]);

const httpInputSchema = z.object({
  body: z.json().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  method: z.enum(['GET', 'POST']).default('GET'),
  url: z.url(),
});

const httpOutputSchema = z.object({
  body: z.unknown(),
  contentType: z.string().nullable(),
  requestId: z.string().nullable(),
  status: z.number().int().min(100).max(599),
});

export type HttpCredential = z.infer<typeof httpCredentialSchema>;
export type HttpInput = z.infer<typeof httpInputSchema>;
export type HttpOutput = z.infer<typeof httpOutputSchema>;

const requestAction: ConnectorAction<HttpInput, HttpOutput, HttpCredential> = {
  cellOutput: { valueType: 'json' },
  description: 'Call a credential-free HTTPS URL with optional stored auth.',
  hostPolicy: { kind: 'runtime' },
  inputFields: [],
  name: 'Request',
  inputSchema: httpInputSchema,
  outputSchema: httpOutputSchema,
  async execute({ context, credential, input }) {
    const url = new URL(input.url);
    assertAllowedUrl(url, context.allowedHosts);

    const headers = new Headers(input.headers);
    assertSafeHeaders(headers);
    headers.set('accept', 'application/json, text/plain;q=0.9');
    headers.set('idempotency-key', context.idempotencyKey);

    if (credential.type === 'bearer') {
      headers.set('authorization', `Bearer ${credential.token}`);
    } else if (credential.type === 'apiKeyHeader') {
      assertSafeCredentialHeader(credential.headerName);
      headers.set(credential.headerName, credential.value);
    }

    let body: string | undefined;
    if (input.method === 'POST' && input.body !== undefined) {
      headers.set('content-type', 'application/json');
      body = JSON.stringify(input.body);
    }

    let response: Response;
    try {
      response = await context.fetch(url, {
        body: body ?? null,
        headers,
        method: input.method,
        redirect: 'manual',
        signal: context.abortSignal,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        'transient',
        'The upstream request could not be completed.',
        true,
        { cause: error }
      );
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ConnectorError(
        'policy',
        'Redirects are disabled for connector requests.',
        false
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new ConnectorError(
        'authentication',
        `The provider rejected the credential with HTTP ${response.status}.`,
        false
      );
    }

    if (response.status === 429) {
      throw new ConnectorError(
        'rate_limited',
        'The provider rate limit was exceeded.',
        true
      );
    }

    if (response.status >= 400 && response.status < 500) {
      throw new ConnectorError(
        'invalid_input',
        `The provider rejected the request with HTTP ${response.status}.`,
        false
      );
    }

    if (response.status >= 500) {
      throw new ConnectorError(
        'upstream',
        `The provider returned HTTP ${response.status}.`,
        true
      );
    }

    const contentLength = Number(response.headers.get('content-length'));
    if (
      Number.isFinite(contentLength) &&
      contentLength > context.maxResponseBytes
    ) {
      throw responseTooLarge(context.maxResponseBytes);
    }

    const bytes = await readBoundedBody(response, context.maxResponseBytes);

    const contentType = response.headers.get('content-type');
    const text = new TextDecoder().decode(bytes);
    let responseBody: unknown = text;
    if (contentType?.toLowerCase().includes('application/json')) {
      try {
        responseBody = text ? (JSON.parse(text) as unknown) : null;
      } catch (error) {
        throw new ConnectorError(
          'upstream',
          'The provider returned malformed JSON.',
          false,
          { cause: error }
        );
      }
    }

    return {
      body: responseBody,
      contentType,
      requestId:
        response.headers.get('x-request-id') ??
        response.headers.get('request-id'),
      status: response.status,
    };
  },
};

export const httpConnector = defineConnector({
  actions: { request: requestAction },
  category: 'http',
  credentialName: 'HTTP credential',
  credentialRequired: false,
  credentialSchema: httpCredentialSchema,
  description: 'Call any explicitly configured HTTPS JSON endpoint.',
  displayName: 'HTTP API',
  documentationUrl: 'https://developer.mozilla.org/en-US/docs/Web/HTTP',
  id: 'http',
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  version: '1.0.0',
}) satisfies ConnectorDefinition<
  HttpCredential,
  { request: typeof requestAction }
>;

function assertAllowedUrl(url: URL, allowedHosts: ReadonlySet<string>): void {
  if (url.protocol !== 'https:') {
    throw new ConnectorError(
      'policy',
      'Connector requests must use HTTPS.',
      false
    );
  }
  if (url.username || url.password) {
    throw new ConnectorError(
      'policy',
      'Credentials are not allowed in connector URLs.',
      false
    );
  }
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new ConnectorError(
      'policy',
      `The host ${url.hostname} is not allowed for this connector.`,
      false
    );
  }
}

function assertSafeHeaders(headers: Headers): void {
  for (const name of headers.keys()) {
    const normalized = name.toLowerCase();
    if (
      normalized === 'authorization' ||
      normalized === 'cookie' ||
      normalized === 'host' ||
      normalized === 'idempotency-key' ||
      normalized === 'proxy-authorization'
    ) {
      throw new ConnectorError(
        'policy',
        `The ${name} header must come from a stored credential or the runtime.`,
        false
      );
    }
  }
}

function assertSafeCredentialHeader(name: string): void {
  const normalized = name.toLowerCase();
  if (
    normalized === 'cookie' ||
    normalized === 'host' ||
    normalized === 'proxy-authorization'
  ) {
    throw new ConnectorError(
      'policy',
      `The ${name} header cannot carry a connector credential.`,
      false
    );
  }
}

function responseTooLarge(limit: number): ConnectorError {
  return new ConnectorError(
    'response_too_large',
    `The provider response exceeded the ${limit}-byte limit.`,
    false
  );
}

async function readBoundedBody(
  response: Response,
  limit: number
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        await reader.cancel();
        throw responseTooLarge(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
