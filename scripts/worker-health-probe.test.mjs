import assert from 'node:assert/strict';
import test from 'node:test';
import { checkWorkerHealth } from './container/worker-health-probe.mjs';

const response = (status, { ok = true } = {}) => ({
  json: async () => ({ status }),
  ok,
});

test('readiness requires a successful HEALTHY response', async () => {
  assert.equal(
    await checkWorkerHealth('ready', {
      fetchImpl: async () => response('HEALTHY'),
      url: 'http://127.0.0.1:8001/health',
    }),
    true
  );
  for (const status of ['INITIALIZED', 'STARTING', 'UNHEALTHY']) {
    assert.equal(
      await checkWorkerHealth('ready', {
        fetchImpl: async () => response(status),
        url: 'http://127.0.0.1:8001/health',
      }),
      false
    );
  }
  assert.equal(
    await checkWorkerHealth('ready', {
      fetchImpl: async () => response('HEALTHY', { ok: false }),
      url: 'http://127.0.0.1:8001/health',
    }),
    false
  );
});

test('liveness accepts every recognized local worker lifecycle state', async () => {
  for (const status of ['INITIALIZED', 'STARTING', 'HEALTHY', 'UNHEALTHY']) {
    assert.equal(
      await checkWorkerHealth('live', {
        fetchImpl: async () => response(status, { ok: false }),
        url: 'http://127.0.0.1:8001/health',
      }),
      true
    );
  }
  assert.equal(
    await checkWorkerHealth('live', {
      fetchImpl: async () => response('UNKNOWN'),
      url: 'http://127.0.0.1:8001/health',
    }),
    false
  );
});

test('network and response failures fail closed without throwing', async () => {
  assert.equal(
    await checkWorkerHealth('ready', {
      fetchImpl: async () => {
        throw new Error('unreachable');
      },
      url: 'http://127.0.0.1:8001/health',
    }),
    false
  );
  assert.equal(
    await checkWorkerHealth('live', {
      fetchImpl: async () => ({ json: async () => ({}) }),
      url: 'http://127.0.0.1:8001/health',
    }),
    false
  );
  assert.equal(await checkWorkerHealth('unsupported'), false);
});
