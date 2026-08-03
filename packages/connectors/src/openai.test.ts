import {
  executeAction,
  extractConnectorCellValue,
} from '@byok-grid/connector-sdk';
import { describe, expect, it, vi } from 'vitest';
import { openAIConnector } from './openai';

function context(fetch: typeof globalThis.fetch) {
  return {
    abortSignal: new AbortController().signal,
    allowedHosts: new Set(['api.openai.com']),
    fetch,
    idempotencyKey: '11111111-1111-4111-8111-111111111111',
    maxResponseBytes: 16_384,
  };
}

describe('OpenAI connector', () => {
  it('keeps the key in the worker request and extracts text plus provenance', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request, init) => {
      expect(String(request)).toBe('https://api.openai.com/v1/responses');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer openai-secret');
      expect(headers.get('x-client-request-id')).toBe(
        '11111111-1111-4111-8111-111111111111'
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toEqual({
        input: 'Classify Acme as B2B or B2C.',
        instructions: 'Return only the classification.',
        max_output_tokens: 1024,
        model: 'gpt-5.6-luna',
        store: false,
      });
      return new Response(
        JSON.stringify({
          id: 'resp_test_1',
          model: 'gpt-5.6-luna-2026-07-15',
          output: [
            {
              content: [{ annotations: [], text: 'B2B', type: 'output_text' }],
              role: 'assistant',
              type: 'message',
            },
          ],
          usage: {
            input_tokens: 32,
            output_tokens: 3,
            total_tokens: 35,
          },
        }),
        { headers: { 'content-type': 'application/json' }, status: 200 }
      );
    });

    const output = await executeAction({
      action: openAIConnector.actions.generate_text,
      context: context(fetch),
      credential: { apiKey: 'openai-secret' },
      credentialSchema: openAIConnector.credentialSchema,
      input: {
        instructions: 'Return only the classification.',
        prompt: 'Classify Acme as B2B or B2C.',
      },
    });

    expect(output).toEqual({
      model: 'gpt-5.6-luna-2026-07-15',
      responseId: 'resp_test_1',
      text: 'B2B',
      usage: { inputTokens: 32, outputTokens: 3, totalTokens: 35 },
    });
    expect(
      extractConnectorCellValue(
        output,
        openAIConnector.actions.generate_text.cellOutput
      )
    ).toEqual({ type: 'text', value: 'B2B' });
  });

  it('classifies authentication and usage limits without exposing error bodies', async () => {
    const unauthorized = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'sensitive' } }), {
          status: 401,
        })
      )
    );
    await expect(
      executeAction({
        action: openAIConnector.actions.generate_text,
        context: context(unauthorized),
        credential: { apiKey: 'bad-key' },
        credentialSchema: openAIConnector.credentialSchema,
        input: { prompt: 'Prompt' },
      })
    ).rejects.toMatchObject({
      code: 'authentication',
      message: 'OpenAI rejected the API key or project access.',
      retryable: false,
    });

    const limited = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(new Response('{}', { status: 429 }))
    );
    await expect(
      executeAction({
        action: openAIConnector.actions.generate_text,
        context: context(limited),
        credential: { apiKey: 'limited-key' },
        credentialSchema: openAIConnector.credentialSchema,
        input: { prompt: 'Prompt' },
      })
    ).rejects.toMatchObject({ code: 'rate_limited', retryable: true });
  });

  it('rejects a successful response that contains no output text', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'resp_without_text',
            model: 'gpt-5.6-luna',
            output: [{ type: 'reasoning' }],
            usage: null,
          }),
          { status: 200 }
        )
      )
    );

    await expect(
      executeAction({
        action: openAIConnector.actions.generate_text,
        context: context(fetch),
        credential: { apiKey: 'openai-secret' },
        credentialSchema: openAIConnector.credentialSchema,
        input: { prompt: 'Prompt' },
      })
    ).rejects.toMatchObject({ code: 'upstream', retryable: false });
  });
});
