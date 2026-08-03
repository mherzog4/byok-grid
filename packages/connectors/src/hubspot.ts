import {
  CONNECTOR_PROTOCOL_VERSION,
  ConnectorError,
  defineConnector,
  type ConnectorAction,
  type ConnectorExecutionContext,
  type ConnectorErrorCode,
} from '@byok-grid/connector-sdk';
import { z } from 'zod';

export const HUBSPOT_API_HOST = 'api.hubapi.com';

export const hubSpotCredentialSchema = z.strictObject({
  accessToken: z
    .string()
    .trim()
    .min(20)
    .max(2_048)
    .refine(
      (value) => !/\p{Cc}/u.test(value),
      'HubSpot access tokens cannot contain control characters.'
    ),
});

const updateContactInputSchema = z.strictObject({
  properties: z.record(z.string(), z.string()),
  recordId: z.string().trim().min(1).max(128),
});

const updateContactOutputSchema = z.looseObject({
  archived: z.boolean().optional(),
  id: z.string().min(1),
  responseStatus: z.number().int().min(200).max(299),
  updatedAt: z.string().optional(),
});

const searchContactsInputSchema = z
  .strictObject({
    after: z.string().trim().min(1).max(1_024).nullable(),
    properties: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[a-z][a-z0-9_]*$/)
      )
      .min(1)
      .max(50),
    windowEnd: z.iso.datetime(),
    windowStart: z.iso.datetime(),
  })
  .refine(
    (input) => Date.parse(input.windowStart) < Date.parse(input.windowEnd),
    'The HubSpot incremental window must move forward.'
  );

const searchContactsOutputSchema = z.looseObject({
  paging: z
    .looseObject({
      next: z.looseObject({ after: z.string() }).optional(),
    })
    .optional(),
  results: z.array(
    z.looseObject({
      archived: z.boolean(),
      createdAt: z.iso.datetime(),
      id: z.string().min(1),
      properties: z.record(z.string(), z.string().nullable()),
      updatedAt: z.iso.datetime(),
    })
  ),
});

export type HubSpotCredential = z.infer<typeof hubSpotCredentialSchema>;
export type HubSpotContactUpdateInput = z.infer<
  typeof updateContactInputSchema
>;
export type HubSpotContactSearchInput = z.infer<
  typeof searchContactsInputSchema
>;

export class HubSpotWritebackError extends ConnectorError {
  constructor(
    code: ConnectorErrorCode,
    message: string,
    retryable: boolean,
    public readonly responseStatus: number
  ) {
    super(code, message, retryable);
  }
}

const updateContactAction: ConnectorAction<
  HubSpotContactUpdateInput,
  z.infer<typeof updateContactOutputSchema>,
  HubSpotCredential
> = {
  cellOutput: { valueType: 'json' },
  description: 'Update selected properties on one HubSpot contact record.',
  hostPolicy: { hosts: [HUBSPOT_API_HOST], kind: 'fixed' },
  inputFields: [],
  inputSchema: updateContactInputSchema,
  name: 'Update Contact',
  outputSchema: updateContactOutputSchema,
  async execute({ context, credential, input }) {
    assertHubSpotHost(context);
    const url = new URL(
      `https://${HUBSPOT_API_HOST}/crm/objects/2026-03/contacts/${encodeURIComponent(input.recordId)}`
    );
    let response: Response;
    try {
      response = await context.fetch(url, {
        body: JSON.stringify({ properties: input.properties }),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${credential.accessToken}`,
          'content-type': 'application/json',
          'idempotency-key': context.idempotencyKey,
        },
        method: 'PATCH',
        redirect: 'manual',
        signal: context.abortSignal,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        'transient',
        'HubSpot could not be reached.',
        true,
        { cause: error }
      );
    }

    classifyHubSpotResponse(response);
    return updateContactOutputSchema.parse({
      ...((await readBoundedJson(
        response,
        context.maxResponseBytes
      )) as object),
      responseStatus: response.status,
    });
  },
};

const searchContactsAction: ConnectorAction<
  HubSpotContactSearchInput,
  z.infer<typeof searchContactsOutputSchema>,
  HubSpotCredential
> = {
  cellOutput: { valueType: 'json' },
  description:
    'Read one cursor page of contacts changed inside a frozen time window.',
  hostPolicy: { hosts: [HUBSPOT_API_HOST], kind: 'fixed' },
  inputFields: [],
  inputSchema: searchContactsInputSchema,
  name: 'Search Changed Contacts',
  outputSchema: searchContactsOutputSchema,
  async execute({ context, credential, input }) {
    assertHubSpotHost(context);
    const url = new URL(
      `https://${HUBSPOT_API_HOST}/crm/objects/2026-03/contacts/search`
    );
    let response: Response;
    try {
      response = await context.fetch(url, {
        body: JSON.stringify({
          after: input.after ?? '0',
          filterGroups: [
            {
              filters: [
                {
                  operator: 'GTE',
                  propertyName: 'hs_lastmodifieddate',
                  value: String(Date.parse(input.windowStart)),
                },
                {
                  operator: 'LT',
                  propertyName: 'hs_lastmodifieddate',
                  value: String(Date.parse(input.windowEnd)),
                },
              ],
            },
          ],
          limit: 100,
          properties: input.properties,
          sorts: ['hs_lastmodifieddate'],
        }),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${credential.accessToken}`,
          'content-type': 'application/json',
        },
        method: 'POST',
        redirect: 'manual',
        signal: context.abortSignal,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        'transient',
        'HubSpot could not be reached.',
        true,
        { cause: error }
      );
    }
    classifyHubSpotResponse(response, 'contact search');
    return searchContactsOutputSchema.parse(
      await readBoundedJson(response, context.maxResponseBytes)
    );
  },
};

export const hubSpotConnector = defineConnector({
  actions: {
    search_changed_contacts: searchContactsAction,
    update_contact: updateContactAction,
  },
  category: 'crm',
  credentialName: 'HubSpot private app token',
  credentialRequired: true,
  credentialSchema: hubSpotCredentialSchema,
  description: 'Incrementally read and write HubSpot CRM contacts.',
  displayName: 'HubSpot',
  documentationUrl:
    'https://developers.hubspot.com/docs/api-reference/latest/crm/objects/contacts',
  id: 'hubspot',
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  version: '1.1.0',
});

function assertHubSpotHost(context: ConnectorExecutionContext): void {
  if (!context.allowedHosts.has(HUBSPOT_API_HOST)) {
    throw new ConnectorError(
      'policy',
      'HubSpot is not allowed by this execution policy.',
      false
    );
  }
}

function classifyHubSpotResponse(
  response: Response,
  operation = 'contact update'
): void {
  if (response.status >= 200 && response.status < 300) return;
  if (response.status >= 300 && response.status < 400) {
    throw new HubSpotWritebackError(
      'policy',
      'HubSpot redirected the request.',
      false,
      response.status
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new HubSpotWritebackError(
      'authentication',
      'HubSpot rejected the private app token or required scope.',
      false,
      response.status
    );
  }
  if (response.status === 429) {
    throw new HubSpotWritebackError(
      'rate_limited',
      'The HubSpot account reached a rate limit.',
      true,
      response.status
    );
  }
  if (
    response.status === 400 ||
    response.status === 404 ||
    response.status === 409 ||
    response.status === 422
  ) {
    throw new HubSpotWritebackError(
      'invalid_input',
      `HubSpot rejected the ${operation} with HTTP ${response.status}.`,
      false,
      response.status
    );
  }
  throw new HubSpotWritebackError(
    'upstream',
    `HubSpot returned HTTP ${response.status}.`,
    response.status >= 500,
    response.status
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
      'HubSpot returned malformed JSON.',
      false,
      { cause: error }
    );
  }
}

function responseTooLarge(limit: number): ConnectorError {
  return new ConnectorError(
    'response_too_large',
    `HubSpot's response exceeded the ${limit}-byte limit.`,
    false
  );
}
