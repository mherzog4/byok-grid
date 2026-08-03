import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_PROTOCOL_VERSION,
  CONNECTOR_SANDBOX_PROTOCOL_VERSION,
  ConnectorError,
  createConnectorManifest,
  defineConnector,
  executeAction,
  extractConnectorCellValue,
  sandboxConnectorInvocationSchema,
  sandboxConnectorResultSchema,
} from './index';

const credentialSchema = z.strictObject({ apiKey: z.string().min(1) });
const action = {
  cellOutput: { valueType: 'json' as const },
  description: 'Looks up one company.',
  hostPolicy: { hosts: ['api.example.com'], kind: 'fixed' as const },
  inputFields: [
    {
      description: 'Company domain.',
      key: 'domain',
      label: 'Domain',
      required: true,
      source: 'column' as const,
    },
  ],
  inputSchema: z.strictObject({ domain: z.string().min(1) }),
  name: 'Company lookup',
  outputSchema: z.strictObject({ company: z.string() }),
  async execute({ input }: { input: { domain: string } }) {
    return { company: input.domain };
  },
};

const connector = defineConnector({
  actions: { lookup: action },
  category: 'data',
  credentialName: 'API key',
  credentialRequired: true,
  credentialSchema,
  description: 'Example connector.',
  displayName: 'Example',
  documentationUrl: 'https://example.com/docs',
  id: 'example',
  protocolVersion: CONNECTOR_PROTOCOL_VERSION,
  version: '1.0.0',
});

describe('connector protocol', () => {
  it('exports serializable schemas without executable functions', () => {
    const manifest = createConnectorManifest(connector);
    expect(manifest).toMatchObject({
      actions: [{ id: 'lookup', inputSchema: { type: 'object' } }],
      id: 'example',
      protocolVersion: '1.1',
    });
    expect(JSON.stringify(manifest)).not.toContain('execute');
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
    expect(hasOnlyPlainJsonObjects(manifest)).toBe(true);
  });

  it('classifies invalid credentials without executing provider code', async () => {
    await expect(
      executeAction({
        action,
        context: {
          abortSignal: new AbortController().signal,
          allowedHosts: new Set(['api.example.com']),
          fetch,
          idempotencyKey: 'run-1',
          maxResponseBytes: 1024,
        },
        credential: {},
        credentialSchema,
        input: { domain: 'example.com' },
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<ConnectorError>>({
        code: 'authentication',
        retryable: false,
      })
    );
  });

  it('rejects invalid fixed host declarations during registration', () => {
    expect(() =>
      defineConnector({
        ...connector,
        actions: {
          lookup: {
            ...action,
            hostPolicy: { hosts: ['https://api.example.com'], kind: 'fixed' },
          },
        },
        id: 'unsafe',
      })
    ).toThrow(/Invalid connector host/);
  });

  it('extracts a typed cell value without discarding full action output', () => {
    const output = {
      meta: { requestId: 'request-1' },
      result: { text: 'Acme' },
    };
    expect(
      extractConnectorCellValue(output, {
        path: ['result', 'text'],
        valueType: 'text',
      })
    ).toEqual({ type: 'text', value: 'Acme' });
    expect(output.meta.requestId).toBe('request-1');
  });

  it('rejects literal field defaults whose declared type is wrong', () => {
    expect(() =>
      defineConnector({
        ...connector,
        actions: {
          lookup: {
            ...action,
            inputFields: [
              {
                defaultValue: 'not-a-number',
                description: 'Limit.',
                key: 'limit',
                label: 'Limit',
                required: true,
                source: 'literal',
                valueType: 'number',
              },
            ],
          },
        },
        id: 'invalid_literal',
      })
    ).toThrow(/does not match number/);
  });

  it('models sandbox networking as a bounded host-executed effect', () => {
    const invocation = sandboxConnectorInvocationSchema.parse({
      actionId: 'lookup',
      connectorId: 'community_example',
      connectorVersion: '1.0.0',
      continuation: null,
      credential: { apiKey: 'secret' },
      input: { domain: 'example.com' },
      protocolVersion: CONNECTOR_SANDBOX_PROTOCOL_VERSION,
      runId: '10000000-0000-4000-8000-000000000001',
    });
    expect(invocation.continuation).toBeNull();
    expect(
      sandboxConnectorResultSchema.parse({
        protocolVersion: CONNECTOR_SANDBOX_PROTOCOL_VERSION,
        step: {
          kind: 'http_request',
          request: {
            bodyBase64: null,
            headers: { authorization: 'Bearer example' },
            method: 'GET',
            url: 'https://api.example.com/company',
          },
          state: { page: 1 },
        },
      })
    ).toMatchObject({ step: { kind: 'http_request' } });
    expect(
      sandboxConnectorResultSchema.safeParse({
        protocolVersion: CONNECTOR_SANDBOX_PROTOCOL_VERSION,
        step: {
          kind: 'http_request',
          request: {
            bodyBase64: null,
            headers: {},
            method: 'GET',
            url: 'http://127.0.0.1/private',
          },
          state: null,
        },
      }).success
    ).toBe(false);
  });
});

function hasOnlyPlainJsonObjects(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(hasOnlyPlainJsonObjects);
  if (Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(hasOnlyPlainJsonObjects);
}
