import {
  CONNECTOR_PROTOCOL_VERSION,
  ConnectorError,
  defineConnector,
  type ConnectorAction,
} from '@byok-grid/connector-sdk';
import { z } from 'zod';

const OPENAI_API_HOST = 'api.openai.com';

export const openAICredentialSchema = z.strictObject({
  apiKey: z.string().trim().min(1).max(512),
});

const openAITextInputSchema = z.strictObject({
  instructions: z.string().trim().min(1).max(10_000).optional(),
  max_output_tokens: z.number().int().min(1).max(32_768).default(1_024),
  model: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
    .default('gpt-5.6-luna'),
  prompt: z.string().trim().min(1).max(100_000),
});

const openAIUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

const openAITextOutputSchema = z.strictObject({
  model: z.string(),
  responseId: z.string(),
  text: z.string(),
  usage: openAIUsageSchema.nullable(),
});

const openAIResponseSchema = z.looseObject({
  id: z.string(),
  model: z.string(),
  output: z.array(
    z.looseObject({
      content: z
        .array(
          z.looseObject({
            text: z.string().optional(),
            type: z.string(),
          })
        )
        .optional(),
      type: z.string(),
    })
  ),
  usage: z
    .looseObject({
      input_tokens: z.number().int().nonnegative(),
      output_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
    })
    .nullable()
    .optional(),
});

export type OpenAICredential = z.infer<typeof openAICredentialSchema>;
export type OpenAITextInput = z.infer<typeof openAITextInputSchema>;
export type OpenAITextOutput = z.infer<typeof openAITextOutputSchema>;

const generateTextAction: ConnectorAction<
  OpenAITextInput,
  OpenAITextOutput,
  OpenAICredential
> = {
  cellOutput: { path: ['text'], valueType: 'text' },
  description:
    'Generate one text enrichment with the OpenAI Responses API and your own API key.',
  hostPolicy: { hosts: [OPENAI_API_HOST], kind: 'fixed' },
  inputFields: [
    {
      description:
        'A text cell containing the row-specific prompt. Use a formula column to combine multiple fields.',
      key: 'prompt',
      label: 'Prompt column',
      required: true,
      source: 'column',
    },
    {
      defaultValue: 'gpt-5.6-luna',
      description:
        'An OpenAI model available to your project. The default favors efficient, high-volume enrichment.',
      key: 'model',
      label: 'Model',
      required: true,
      source: 'literal',
      valueType: 'text',
    },
    {
      description:
        'Optional instructions applied consistently to every row in this column.',
      key: 'instructions',
      label: 'Instructions',
      multiline: true,
      required: false,
      source: 'literal',
      valueType: 'text',
    },
    {
      defaultValue: 1_024,
      description:
        'Maximum generated tokens, including visible output and reasoning tokens.',
      key: 'max_output_tokens',
      label: 'Maximum output tokens',
      required: true,
      source: 'literal',
      valueType: 'number',
    },
  ],
  inputSchema: openAITextInputSchema,
  name: 'Generate Text',
  outputSchema: openAITextOutputSchema,
  async execute({ context, credential, input }) {
    let response: Response;
    try {
      response = await context.fetch('https://api.openai.com/v1/responses', {
        body: JSON.stringify({
          input: input.prompt,
          ...(input.instructions ? { instructions: input.instructions } : {}),
          max_output_tokens: input.max_output_tokens,
          model: input.model,
          store: false,
        }),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${credential.apiKey}`,
          'content-type': 'application/json',
          'x-client-request-id': context.idempotencyKey,
        },
        method: 'POST',
        redirect: 'manual',
        signal: context.abortSignal,
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(
        'transient',
        'OpenAI could not be reached.',
        true,
        { cause: error }
      );
    }

    classifyOpenAIResponse(response);
    const parsed = openAIResponseSchema.safeParse(
      await readBoundedJson(response, context.maxResponseBytes)
    );
    if (!parsed.success) {
      throw new ConnectorError(
        'upstream',
        'OpenAI returned an invalid Responses API payload.',
        false,
        { cause: parsed.error }
      );
    }

    const text = parsed.data.output
      .flatMap((item) => item.content ?? [])
      .filter((part) => part.type === 'output_text')
      .flatMap((part) => (part.text === undefined ? [] : [part.text]))
      .join('\n');
    if (!text) {
      throw new ConnectorError(
        'upstream',
        'OpenAI completed without a text output.',
        false
      );
    }

    const usage = parsed.data.usage
      ? {
          inputTokens: parsed.data.usage.input_tokens,
          outputTokens: parsed.data.usage.output_tokens,
          totalTokens: parsed.data.usage.total_tokens,
        }
      : null;
    return {
      model: parsed.data.model,
      responseId: parsed.data.id,
      text,
      usage,
    };
  },
};

export const openAIConnector = defineConnector({
  actions: { generate_text: generateTextAction },
  category: 'ai',
  credentialName: 'OpenAI API key',
  credentialRequired: true,
  credentialSchema: openAICredentialSchema,
  description:
    'Generate row-level AI enrichments through the Responses API using your own OpenAI project key.',
  displayName: 'OpenAI',
  documentationUrl: 'https://developers.openai.com/api/docs/guides/text',
  id: 'openai',
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  version: '1.0.0',
});

function classifyOpenAIResponse(response: Response): void {
  if (response.status >= 200 && response.status < 300) return;
  if (response.status >= 300 && response.status < 400) {
    throw new ConnectorError(
      'policy',
      'OpenAI redirected the API request.',
      false
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConnectorError(
      'authentication',
      'OpenAI rejected the API key or project access.',
      false
    );
  }
  if (response.status === 429) {
    throw new ConnectorError(
      'rate_limited',
      'The OpenAI project reached a rate or usage limit.',
      true
    );
  }
  if (response.status === 408 || response.status === 409) {
    throw new ConnectorError(
      'transient',
      `OpenAI returned HTTP ${response.status}.`,
      true
    );
  }
  if (response.status >= 400 && response.status < 500) {
    throw new ConnectorError(
      'invalid_input',
      `OpenAI rejected the request with HTTP ${response.status}.`,
      false
    );
  }
  throw new ConnectorError(
    'upstream',
    `OpenAI returned HTTP ${response.status}.`,
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
      'OpenAI returned malformed JSON.',
      false,
      { cause: error }
    );
  }
}

function responseTooLarge(limit: number): ConnectorError {
  return new ConnectorError(
    'response_too_large',
    `OpenAI's response exceeded the ${limit}-byte limit.`,
    false
  );
}
