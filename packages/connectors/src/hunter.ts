import {
  CONNECTOR_PROTOCOL_VERSION,
  ConnectorError,
  defineConnector,
  type ConnectorAction,
  type ConnectorExecutionContext,
} from '@byok-grid/connector-sdk';
import { z } from 'zod';

const HUNTER_API_HOST = 'api.hunter.io';

export const hunterCredentialSchema = z.strictObject({
  apiKey: z.string().trim().min(1).max(512),
});

const hunterDomainSearchInputSchema = z.strictObject({
  domain: z.string().trim().min(1).max(253),
  limit: z.number().int().min(1).max(10).default(10),
});

const hunterEmailSchema = z.looseObject({
  confidence: z.number().min(0).max(100).nullable().optional(),
  department: z.string().nullable().optional(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  position: z.string().nullable().optional(),
  seniority: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  value: z.string().email(),
  verification: z
    .looseObject({ status: z.string().nullable().optional() })
    .nullable()
    .optional(),
});

const hunterDomainSearchOutputSchema = z.looseObject({
  data: z.looseObject({
    accept_all: z.boolean().nullable().optional(),
    disposable: z.boolean().nullable().optional(),
    domain: z.string(),
    emails: z.array(hunterEmailSchema),
    organization: z.string().nullable().optional(),
    pattern: z.string().nullable().optional(),
    webmail: z.boolean().nullable().optional(),
  }),
  meta: z.looseObject({
    limit: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    results: z.number().int().nonnegative(),
  }),
});

export type HunterCredential = z.infer<typeof hunterCredentialSchema>;
export type HunterDomainSearchInput = z.infer<
  typeof hunterDomainSearchInputSchema
>;
export type HunterDomainSearchOutput = z.infer<
  typeof hunterDomainSearchOutputSchema
>;

const domainSearchAction: ConnectorAction<
  HunterDomainSearchInput,
  HunterDomainSearchOutput,
  HunterCredential
> = {
  cellOutput: { valueType: 'json' },
  description:
    'Find public professional email addresses associated with a company domain.',
  hostPolicy: { hosts: [HUNTER_API_HOST], kind: 'fixed' },
  inputFields: [
    {
      description: 'The company domain to search, such as example.com.',
      key: 'domain',
      label: 'Domain column',
      required: true,
      source: 'column',
    },
  ],
  inputSchema: hunterDomainSearchInputSchema,
  name: 'Domain Search',
  outputSchema: hunterDomainSearchOutputSchema,
  async execute({ context, credential, input }) {
    const url = new URL('https://api.hunter.io/v2/domain-search');
    url.searchParams.set('domain', input.domain.toLowerCase());
    url.searchParams.set('limit', String(input.limit));
    // This value is constructed only inside the worker. It is never persisted
    // in a cell run, outbox event, column configuration, or application log.
    url.searchParams.set('api_key', credential.apiKey);

    let response: Response;
    try {
      response = await context.fetch(url, {
        headers: { accept: 'application/json' },
        method: 'GET',
        redirect: 'manual',
        signal: context.abortSignal,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        'transient',
        'Hunter could not be reached.',
        true,
        { cause: error }
      );
    }

    classifyHunterResponse(response);
    return hunterDomainSearchOutputSchema.parse(
      await readBoundedJson(response, context.maxResponseBytes)
    );
  },
};

export const hunterConnector = defineConnector({
  actions: { domain_search: domainSearchAction },
  category: 'email',
  credentialName: 'Hunter API key',
  credentialRequired: true,
  credentialSchema: hunterCredentialSchema,
  description:
    'Discover public professional email addresses using your own Hunter account.',
  displayName: 'Hunter',
  documentationUrl: 'https://hunter.io/api-documentation/v2',
  id: 'hunter',
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  version: '1.0.0',
});

function classifyHunterResponse(response: Response): void {
  if (response.status >= 200 && response.status < 300) return;
  if (response.status >= 300 && response.status < 400) {
    throw new ConnectorError('policy', 'Hunter redirected the request.', false);
  }
  if (response.status === 401) {
    throw new ConnectorError(
      'authentication',
      'Hunter rejected the API key.',
      false
    );
  }
  // TODO(product owner): Hunter documents 403 as a rate-limit response, but
  // some restricted accounts may also return it. Decide whether 403 should
  // keep retrying with 429 (current behavior) or fail as authentication.
  if (response.status === 403 || response.status === 429) {
    throw new ConnectorError(
      'rate_limited',
      'The Hunter account reached a rate or usage limit.',
      true
    );
  }
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 422 ||
    response.status === 451
  ) {
    throw new ConnectorError(
      'invalid_input',
      `Hunter rejected the request with HTTP ${response.status}.`,
      false
    );
  }
  throw new ConnectorError(
    'upstream',
    `Hunter returned HTTP ${response.status}.`,
    response.status >= 500
  );
}

async function readBoundedJson(
  response: Response,
  limit: number
): Promise<unknown> {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw responseTooLarge(limit);
  }
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw responseTooLarge(limit);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch (error) {
    throw new ConnectorError(
      'upstream',
      'Hunter returned malformed JSON.',
      false,
      { cause: error }
    );
  }
}

function responseTooLarge(limit: number): ConnectorError {
  return new ConnectorError(
    'response_too_large',
    `Hunter's response exceeded the ${limit}-byte limit.`,
    false
  );
}
