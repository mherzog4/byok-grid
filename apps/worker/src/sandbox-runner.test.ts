import { ConnectorError } from '@byok-grid/connectors';
import { describe, expect, it, vi } from 'vitest';
import {
  executeSandboxConnector,
  signSandboxRunnerRequest,
} from './sandbox-runner';

const runner = {
  sharedSecret: 'a deployment secret with at least 32 bytes',
  url: 'http://connector-runner:4319',
};

const execution = {
  actionId: 'lookup',
  connectorId: 'community_lookup',
  connectorVersion: '1.0.0',
  credential: { secret: 'workspace-owned' },
  credentialSchema: {
    additionalProperties: false,
    properties: { secret: { minLength: 8, type: 'string' } },
    required: ['secret'],
    type: 'object',
  },
  hostPolicy: { hosts: ['api.example.com'], kind: 'fixed' },
  input: { domain: 'example.com' },
  inputSchema: {
    additionalProperties: false,
    properties: { domain: { type: 'string' } },
    required: ['domain'],
    type: 'object',
  },
  outputSchema: {
    additionalProperties: false,
    properties: { company: { type: 'string' } },
    required: ['company'],
    type: 'object',
  },
  runId: '10000000-0000-4000-8000-000000000001',
} as const;

describe('sandbox connector effect loop', () => {
  it('signs the exact timestamp and body envelope', () => {
    expect(signSandboxRunnerRequest(runner.sharedSecret, 123, '{}')).toBe(
      '8d524e1773cbf6e03b66b2a33258d328a59322fbb4ec279f689b7466a9b99b83'
    );
  });

  it('keeps HTTP on the guarded host path and returns the completed output', async () => {
    const runnerFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          protocolVersion: '1.0',
          step: {
            kind: 'http_request',
            request: {
              bodyBase64: null,
              headers: { accept: 'application/json' },
              method: 'GET',
              url: 'https://api.example.com/v1/lookup',
            },
            state: { page: 1 },
          },
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          protocolVersion: '1.0',
          step: {
            kind: 'complete',
            output: { company: 'Example' },
          },
        })
      );
    const egressFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        Response.json({ company: 'Example' }, { status: 200 })
      );

    await expect(
      executeSandboxConnector(execution, runner, {
        egressFetch,
        runnerFetch,
      })
    ).resolves.toEqual({ company: 'Example' });
    expect(egressFetch).toHaveBeenCalledWith(
      new URL('https://api.example.com/v1/lookup'),
      expect.objectContaining({ method: 'GET', redirect: 'error' })
    );
    const secondInvocation = JSON.parse(
      String(runnerFetch.mock.calls[1]?.[1]?.body)
    );
    expect(secondInvocation.continuation).toMatchObject({
      response: { status: 200 },
      state: { page: 1 },
    });
  });

  it('rejects undeclared hosts before any egress request', async () => {
    const runnerFetch = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        protocolVersion: '1.0',
        step: {
          kind: 'http_request',
          request: {
            bodyBase64: null,
            headers: {},
            method: 'GET',
            url: 'https://metadata.example.net/private',
          },
          state: null,
        },
      })
    );
    const egressFetch = vi.fn<typeof fetch>();
    await expect(
      executeSandboxConnector(execution, runner, {
        egressFetch,
        runnerFetch,
      })
    ).rejects.toMatchObject({
      code: 'policy',
    } satisfies Partial<ConnectorError>);
    expect(egressFetch).not.toHaveBeenCalled();
  });

  it('rejects invalid credentials before RPC and invalid guest output after RPC', async () => {
    const runnerFetch = vi.fn<typeof fetch>();
    await expect(
      executeSandboxConnector(
        { ...execution, credential: { secret: 'short' } },
        runner,
        { runnerFetch }
      )
    ).rejects.toMatchObject({ code: 'authentication' });
    expect(runnerFetch).not.toHaveBeenCalled();

    runnerFetch.mockResolvedValue(
      Response.json({
        protocolVersion: '1.0',
        step: { kind: 'complete', output: { unexpected: true } },
      })
    );
    await expect(
      executeSandboxConnector(execution, runner, { runnerFetch })
    ).rejects.toMatchObject({ code: 'upstream' });
  });
});
