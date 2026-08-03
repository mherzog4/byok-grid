#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';
import {
  extractInFlightMarker,
  inspectRestartedWorkerPod,
  inspectSingleReadyWorkerPod,
  inspectWorkerDeployment,
  parseDrainEnvironment,
  validateCurrentContext,
  validateDrainLogs,
} from './drill-kubernetes-workflow-drain-lib.mjs';

const root = resolve(import.meta.dirname, '..');
let config;
let testProcess;

try {
  if (process.platform === 'win32') {
    throw new Error(
      'The Kubernetes workflow drain drill requires a Unix-like operator host.'
    );
  }
  config = parseDrainEnvironment(process.env);
  validateCurrentContext(
    await kubectlOutput(config, ['config', 'current-context']),
    config.context
  );

  const deployment = inspectWorkerDeployment(
    await kubectlJson(config, [
      'get',
      'deployment',
      config.deployment,
      '--output=json',
    ])
  );
  const originalPod = inspectSingleReadyWorkerPod(
    await workerPods(config, deployment.selector)
  );
  await verifyWorkerHealth(config, originalPod.name);
  await verifyWorkerIdle(config, originalPod.name);

  const startedAt = performance.now();
  const marker = await startWorkflowFixture(config);
  const signalStartedAt = performance.now();
  await signalWorker(config, originalPod.name);

  const restartedPod = await waitForRestart(
    config,
    deployment.selector,
    originalPod,
    Math.min(
      config.timeoutMs,
      deployment.terminationGracePeriodSeconds * 1_000,
      90_000
    )
  );
  const drainMs = Math.round(performance.now() - signalStartedAt);
  const previousLogs = await kubectlOutput(config, [
    'logs',
    restartedPod.name,
    '--container=worker',
    '--previous',
  ]);
  validateDrainLogs(previousLogs);
  await verifyWorkerHealth(config, restartedPod.name);

  const testExit = await waitForExit(testProcess, config.timeoutMs);
  if (testExit.code !== 0) {
    throw new Error(
      'The workflow fixture did not reach a successful terminal state after the worker restart.'
    );
  }
  await verifyWorkerIdle(config, restartedPod.name);

  process.stdout.write(
    `${JSON.stringify({
      context: config.context,
      deployment: config.deployment,
      drainMs,
      elapsedMs: Math.round(performance.now() - startedAt),
      marker: 'BYOK_GRID_KUBERNETES_WORKER_DRAIN_VERIFIED',
      namespace: config.namespace,
      podUid: restartedPod.uid,
      restartCount: restartedPod.restartCount,
      rowCount: marker.rowCount,
      runId: marker.runId,
      signal: 'SIGTERM',
      verifiedAt: new Date().toISOString(),
    })}\n`
  );
} catch (error) {
  process.stderr.write(
    `Authenticated Kubernetes workflow drain drill failed: ${safeMessage(error)}\n`
  );
  process.exitCode = 1;
} finally {
  if (testProcess?.exitCode === null && testProcess.signalCode === null) {
    await waitForExit(
      testProcess,
      Math.min(config?.timeoutMs ?? 10_000, 120_000)
    ).catch(async () => {
      testProcess.kill('SIGTERM');
      await waitForExit(testProcess, 10_000).catch(async () => {
        testProcess.kill('SIGKILL');
        await waitForExit(testProcess, 5_000).catch(() => undefined);
      });
    });
  }
}

async function startWorkflowFixture(config) {
  testProcess = spawn(
    'npm',
    [
      'test',
      '--workspace=@byok-grid/web',
      '--',
      '--run',
      'src/workflow-sqlite.e2e.test.ts',
      '--reporter=verbose',
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        RUN_SQLITE_WEB_E2E: '1',
        TEST_APP_ORIGIN: config.appOrigin,
        TEST_APP_URL: config.appOrigin,
        TEST_SQLITE_AUTH_TOKEN: config.databaseAuthToken,
        TEST_SQLITE_DATABASE_URL: config.databaseUrl,
        VERIFY_WORKFLOW_EXECUTION: '1',
        WORKFLOW_DRAIN_DRILL_ROWS: '500',
        WORKFLOW_DRILL_EMAIL: config.email,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );

  let buffered = '';
  let resolveMarker;
  const markerPromise = new Promise((resolvePromise) => {
    resolveMarker = resolvePromise;
  });
  const observe = (chunk) => {
    buffered = `${buffered}${chunk.toString()}`.slice(-65_536);
    const marker = extractInFlightMarker(buffered);
    if (marker) resolveMarker(marker);
  };
  testProcess.stdout.on('data', observe);
  testProcess.stderr.on('data', observe);

  const exitPromise = childExit(testProcess);
  const result = await Promise.race([
    markerPromise.then((marker) => ({ kind: 'marker', marker })),
    exitPromise.then(() => ({ kind: 'exit' })),
    timeout(config.timeoutMs, 'The workflow fixture did not become in-flight.'),
  ]);
  if (result.kind !== 'marker') {
    throw new Error(
      'The workflow fixture exited before exposing a running Hatchet step.'
    );
  }
  return result.marker;
}

async function signalWorker(config, podName) {
  // The exec transport can close as PID 1 exits. Restart evidence, not this
  // command's status, proves that the signal reached the target process.
  await kubectl(config, [
    'exec',
    podName,
    '--container=worker',
    '--',
    'node',
    '--eval',
    "process.kill(1, 'SIGTERM')",
  ]);
}

async function waitForRestart(config, selector, originalPod, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latestError;
  while (Date.now() < deadline) {
    try {
      return inspectRestartedWorkerPod(
        await workerPods(config, selector),
        originalPod
      );
    } catch (error) {
      latestError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error(
    latestError instanceof Error
      ? latestError.message
      : 'The workflow-worker did not restart before the deadline.'
  );
}

async function verifyWorkerHealth(config, podName) {
  const result = await kubectlOutput(config, [
    'exec',
    podName,
    '--container=worker',
    '--',
    'node',
    '--eval',
    "fetch('http://127.0.0.1:8001/health').then(async response => { const body = await response.json(); if (!response.ok || body.status !== 'HEALTHY' || body.name !== 'byok-grid-workflow-worker' || !Array.isArray(body.actions) || body.actions.length === 0) process.exit(1); process.stdout.write(JSON.stringify({status: body.status})) }).catch(() => process.exit(1))",
  ]);
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error('The workflow-worker health response was malformed.');
  }
  if (parsed.status !== 'HEALTHY') {
    throw new Error('The workflow-worker did not report authenticated health.');
  }
}

async function verifyWorkerIdle(config, podName) {
  const result = await kubectlOutput(config, [
    'exec',
    podName,
    '--container=worker',
    '--',
    'node',
    '--eval',
    "fetch('http://127.0.0.1:8002/metrics').then(async response => { const body = await response.text(); const required = ['byok_grid_workflow_runs{status=\"queued\"} 0', 'byok_grid_workflow_runs{status=\"running\"} 0', 'byok_grid_workflow_active_steps{status=\"ready\"} 0', 'byok_grid_workflow_active_steps{status=\"running\"} 0', 'byok_grid_outbox_unpublished_events 0']; if (!response.ok || !required.every(line => body.includes(line))) process.exit(1); process.stdout.write(JSON.stringify({idle: true})) }).catch(() => process.exit(1))",
  ]);
  let parsed;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new Error('The workflow-worker application metrics were malformed.');
  }
  if (parsed.idle !== true) {
    throw new Error(
      'The isolated environment has active workflow or dispatch state.'
    );
  }
}

function workerPods(config, selector) {
  return kubectlJson(config, [
    'get',
    'pods',
    `--selector=${selector}`,
    '--output=json',
  ]);
}

async function kubectlJson(config, args) {
  const output = await kubectlOutput(config, args);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('kubectl returned malformed JSON.');
  }
}

async function kubectlOutput(config, args) {
  const chunks = [];
  const exit = await kubectl(config, args, (chunk) => chunks.push(chunk));
  if (exit.code !== 0)
    throw new Error('kubectl could not complete a drill check.');
  return Buffer.concat(chunks).toString().trim();
}

function kubectl(config, args, onStdout) {
  const child = spawn(
    'kubectl',
    [
      '--context',
      config.context,
      '--namespace',
      config.namespace,
      '--request-timeout=15s',
      ...args,
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let outputBytes = 0;
  child.stdout.on('data', (chunk) => {
    outputBytes += chunk.length;
    if (outputBytes <= 1_048_576) onStdout?.(chunk);
  });
  child.stderr.resume();
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000);
  deadline.unref();
  return childExit(child).finally(() => clearTimeout(deadline));
}

function waitForExit(child, timeoutMs) {
  return Promise.race([
    childExit(child),
    timeout(timeoutMs, 'A child process did not exit before the deadline.'),
  ]);
}

function childExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

function timeout(milliseconds, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    timer.unref();
  });
}

function safeMessage(error) {
  return error instanceof Error
    ? error.message
    : 'The drill failed for an unknown reason.';
}
