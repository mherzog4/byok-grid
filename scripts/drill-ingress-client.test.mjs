import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  INGRESS_CLIENT_PROBE_MARKER,
  ingressClientProbeConfig,
  runIngressClientProbe,
  verifyIngressClientProbeRecord,
} from './drill-ingress-client-lib.mjs';

const COMMIT = 'a'.repeat(40);

describe('production ingress client probe', () => {
  it('requires explicit bounded candidate and network configuration', () => {
    assert.deepEqual(
      ingressClientProbeConfig(
        ['node', 'script', 'https://grid.example.test'],
        {
          BYOK_GRID_CANDIDATE_COMMIT: COMMIT,
          BYOK_GRID_EDGE_RATE_LIMIT_MAX_ATTEMPTS: '20',
          BYOK_GRID_INGRESS_NETWORK_ID: 'mobile-provider-a',
          BYOK_GRID_INGRESS_PROBE_CHALLENGE: 'shared-challenge-0001',
          BYOK_GRID_INGRESS_PROBE_CONFIRM: 'controlled-production-candidate',
        }
      ),
      {
        candidateCommit: COMMIT,
        challenge: 'shared-challenge-0001',
        edgeMaximumAttempts: 20,
        networkId: 'mobile-provider-a',
        origin: 'https://grid.example.test',
      }
    );

    assert.throws(
      () =>
        ingressClientProbeConfig(
          ['node', 'script', 'https://grid.example.test'],
          {
            BYOK_GRID_CANDIDATE_COMMIT: COMMIT,
            BYOK_GRID_EDGE_RATE_LIMIT_MAX_ATTEMPTS: '101',
            BYOK_GRID_INGRESS_NETWORK_ID: 'network-a',
          }
        ),
      /confirmation/u
    );
  });

  it('proves public health and distinct application and edge limits', async () => {
    let applicationAttempts = 0;
    let edgeAttempts = 0;
    const result = await runIngressClientProbe({
      candidateCommit: COMMIT,
      challenge: 'shared-challenge-0001',
      edgeMaximumAttempts: 10,
      fetchImplementation: async (input, init) => {
        const url = new URL(input);
        if (url.pathname === '/api/auth/sign-in/email') {
          applicationAttempts += 1;
          assert.equal(init.method, 'POST');
          assert.equal(init.headers.origin, 'https://grid.example.test');
          if (applicationAttempts < 4)
            return new Response(null, { status: 401 });
          return new Response(null, {
            headers: {
              'x-byok-grid-rate-limit-layer': 'application',
              'x-retry-after': '10',
            },
            status: 429,
          });
        }
        if (url.pathname === '/sign-in') {
          edgeAttempts += 1;
          if (edgeAttempts === 1) return new Response(null, { status: 200 });
          return new Response(null, {
            headers: {
              'retry-after': '30',
              'x-byok-grid-rate-limit-layer': 'edge',
            },
            status: 429,
          });
        }
        throw new Error('unexpected path');
      },
      networkId: 'mobile-provider-a',
      now: () => new Date('2026-08-04T20:00:00.000Z'),
      origin: 'https://grid.example.test',
      randomUUIDImplementation: () => '11111111-1111-4111-8111-111111111111',
      verifyPublicDeploymentImplementation: async () => ({
        marker: 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
        requests: 4,
      }),
    });

    assert.equal(result.marker, INGRESS_CLIENT_PROBE_MARKER);
    assert.equal(result.candidateCommit, COMMIT);
    assert.equal(result.networkIdSha256.length, 64);
    assert.deepEqual(result.checks, {
      applicationRateLimit: {
        acceptedResponses: 3,
        attempts: 4,
        limitedStatus: 429,
        observedAt: '2026-08-04T20:00:00.000Z',
        retryAfterSeconds: 10,
      },
      edgeRateLimit: {
        acceptedResponses: 1,
        attempts: 2,
        limitedStatus: 429,
        observedAt: '2026-08-04T20:00:00.000Z',
        retryAfterSeconds: 30,
      },
      publicDeployment: {
        marker: 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
        requests: 4,
      },
    });
  });

  it('rejects a 429 without exact layer provenance', async () => {
    let applicationAttempts = 0;
    await assert.rejects(
      runIngressClientProbe({
        candidateCommit: COMMIT,
        challenge: 'shared-challenge-0001',
        edgeMaximumAttempts: 10,
        fetchImplementation: async (input) => {
          if (new URL(input).pathname === '/api/auth/sign-in/email') {
            applicationAttempts += 1;
            return applicationAttempts < 4
              ? new Response(null, { status: 401 })
              : new Response(null, {
                  headers: { 'x-retry-after': '10' },
                  status: 429,
                });
          }
          throw new Error('unexpected request');
        },
        networkId: 'network-a',
        origin: 'https://grid.example.test',
        verifyPublicDeploymentImplementation: async () => ({
          marker: 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
          requests: 4,
        }),
      }),
      /lacked layer provenance/u
    );
  });

  it('validates the closed client evidence shape', () => {
    const record = clientRecord();
    assert.deepEqual(verifyIngressClientProbeRecord(record), record);

    const extra = structuredClone(record);
    extra.debug = true;
    assert.throws(
      () => verifyIngressClientProbeRecord(extra),
      /unexpected fields/u
    );

    const wrongStatus = structuredClone(record);
    wrongStatus.checks.edgeRateLimit.limitedStatus = 503;
    assert.throws(
      () => verifyIngressClientProbeRecord(wrongStatus),
      /invalid/u
    );

    const partialApplicationProof = structuredClone(record);
    partialApplicationProof.checks.applicationRateLimit.acceptedResponses = 1;
    partialApplicationProof.checks.applicationRateLimit.attempts = 2;
    assert.throws(
      () => verifyIngressClientProbeRecord(partialApplicationProof),
      /invalid/u
    );

    const outOfOrder = structuredClone(record);
    outOfOrder.checks.applicationRateLimit.observedAt =
      '2026-08-04T20:00:01.000Z';
    assert.throws(
      () => verifyIngressClientProbeRecord(outOfOrder),
      /execution order/u
    );
  });

  it('fails before network access without the explicit confirmation', () => {
    const result = spawnSync(
      process.execPath,
      [
        resolve(import.meta.dirname, 'drill-ingress-client.mjs'),
        'https://grid.example.test',
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          BYOK_GRID_CANDIDATE_COMMIT: COMMIT,
          BYOK_GRID_EDGE_RATE_LIMIT_MAX_ATTEMPTS: '20',
          BYOK_GRID_INGRESS_NETWORK_ID: 'network-a',
          BYOK_GRID_INGRESS_PROBE_CHALLENGE: 'shared-challenge-0001',
          BYOK_GRID_INGRESS_PROBE_CONFIRM: '',
        },
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /confirmation/u);
    assert.doesNotMatch(
      result.stdout,
      /BYOK_GRID_INGRESS_CLIENT_PROBE_VERIFIED/u
    );
  });
});

function clientRecord() {
  return {
    candidateCommit: COMMIT,
    challengeSha256: 'a'.repeat(64),
    checks: {
      applicationRateLimit: {
        acceptedResponses: 3,
        attempts: 4,
        limitedStatus: 429,
        observedAt: '2026-08-04T20:00:00.000Z',
        retryAfterSeconds: 10,
      },
      edgeRateLimit: {
        acceptedResponses: 9,
        attempts: 10,
        limitedStatus: 429,
        observedAt: '2026-08-04T20:00:00.000Z',
        retryAfterSeconds: 30,
      },
      publicDeployment: {
        marker: 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
        requests: 4,
      },
    },
    marker: INGRESS_CLIENT_PROBE_MARKER,
    networkIdSha256: 'b'.repeat(64),
    origin: 'https://grid.example.test',
    verifiedAt: '2026-08-04T20:00:00.000Z',
  };
}
