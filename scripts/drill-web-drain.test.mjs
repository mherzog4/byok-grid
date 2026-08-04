import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WebDrainObservationError,
  isConnectionRejection,
  observeListenerClosure,
} from './drill-web-drain-lib.mjs';

function observation(overrides = {}) {
  let currentTime = 0;
  return observeListenerClosure({
    canConnect: overrides.canConnect ?? (async () => false),
    isProcessExited: overrides.isProcessExited ?? (() => false),
    isRequestSettled: overrides.isRequestSettled ?? (() => false),
    now: () => currentTime,
    pollIntervalMilliseconds: overrides.pollIntervalMilliseconds ?? 10,
    sleep: async (milliseconds) => {
      currentTime += milliseconds;
    },
    startedAt: 0,
    timeoutMilliseconds: overrides.timeoutMilliseconds ?? 100,
  });
}

test('observes listener closure while the process and request remain active', async () => {
  const probes = [true, true, false];
  const elapsed = await observation({
    canConnect: async () => probes.shift() ?? false,
  });
  assert.equal(elapsed, 20);
});

test('rejects a process exit before the proof point', async () => {
  await assert.rejects(
    observation({
      canConnect: async () => false,
      isProcessExited: () => true,
    }),
    WebDrainObservationError
  );
});

test('rejects a completed request before the proof point', async () => {
  await assert.rejects(
    observation({
      canConnect: async () => false,
      isRequestSettled: () => true,
    }),
    /request completed before listener closure/u
  );
});

test('rejects a listener that remains open through the deadline', async () => {
  await assert.rejects(
    observation({
      canConnect: async () => true,
      timeoutMilliseconds: 25,
    }),
    /continued accepting new connections for 30ms/u
  );
});

test('rejects invalid observation timing', async () => {
  await assert.rejects(
    observeListenerClosure({
      canConnect: async () => false,
      isProcessExited: () => false,
      isRequestSettled: () => false,
      pollIntervalMilliseconds: 0,
      startedAt: 0,
    }),
    TypeError
  );
});

test('recognizes cross-platform listener rejection codes only', () => {
  assert.equal(isConnectionRejection({ code: 'ECONNREFUSED' }), true);
  assert.equal(isConnectionRejection({ code: 'ECONNRESET' }), true);
  assert.equal(isConnectionRejection({ code: 'ETIMEDOUT' }), false);
  assert.equal(isConnectionRejection(undefined), false);
});
