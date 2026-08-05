#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const marker = 'BYOK_GRID_DRAIN_DRILL_IN_FLIGHT';
const root = resolve(import.meta.dirname, '..');
const runnerImage = 'byok-grid-web-e2e-runner';
let testProcess;
let workerStopped = false;

try {
  const webContainer = await output('docker', [
    'compose',
    'ps',
    '--quiet',
    'web',
  ]);
  if (!webContainer) {
    throw new Error(
      'The Compose web service is not running. Start the app profile first.'
    );
  }
  const sqliteVolume = await output('docker', [
    'inspect',
    webContainer,
    '--format',
    '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}',
  ]);
  if (!sqliteVolume) {
    throw new Error('The running web service has no named /data volume.');
  }

  await waitForWorkerHealth();
  await verifyOperationalMetrics();
  const drillStartedAt = new Date().toISOString();
  await run('docker', [
    'build',
    '--target',
    'web-builder',
    '--tag',
    runnerImage,
    '.',
  ]);

  const test = (testProcess = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      `container:${webContainer}`,
      '--volume',
      `${sqliteVolume}:/data`,
      '--env',
      'RUN_SQLITE_WEB_E2E=1',
      '--env',
      'VERIFY_WORKFLOW_EXECUTION=1',
      '--env',
      'WORKFLOW_DRAIN_DRILL_ROWS=500',
      '--env',
      'TEST_APP_URL=http://127.0.0.1:3000',
      '--env',
      'TEST_APP_ORIGIN=http://localhost:3000',
      '--env',
      'TEST_SQLITE_DATABASE_URL=file:/data/byok-grid.sqlite',
      runnerImage,
      'npm',
      'test',
      '--workspace=@byok-grid/web',
      '--',
      '--run',
      'src/workflow-sqlite.e2e.test.ts',
      '--reporter=verbose',
    ],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
  ));
  let sawMarker = false;
  let signalPromise;
  let resolveMarker;
  const markerObserved = new Promise((resolvePromise) => {
    resolveMarker = resolvePromise;
  });
  const observe = (chunk, destination) => {
    const text = chunk.toString();
    destination.write(text);
    if (!sawMarker && text.includes(marker)) {
      sawMarker = true;
      signalPromise = stopWorker();
      resolveMarker();
    }
  };
  test.stdout.on('data', (chunk) => observe(chunk, process.stdout));
  test.stderr.on('data', (chunk) => observe(chunk, process.stderr));

  const testExitPromise = childExit(test);
  const firstEvent = await Promise.race([
    markerObserved.then(() => ({ kind: 'marker' })),
    testExitPromise.then((exit) => ({ exit, kind: 'exit' })),
  ]);
  if (firstEvent.kind === 'exit') {
    throw new Error('The workflow test exited without an in-flight marker.');
  }
  try {
    await signalPromise;
  } catch (error) {
    test.kill('SIGTERM');
    await testExitPromise;
    throw error;
  }

  const workerContainer = await output('docker', [
    'compose',
    'ps',
    '--all',
    '--quiet',
    'workflow-worker',
  ]);
  if (!workerContainer) {
    throw new Error('The stopped workflow-worker container was not found.');
  }
  const state = JSON.parse(
    await output('docker', [
      'inspect',
      workerContainer,
      '--format',
      '{{json .State}}',
    ])
  );
  if (state.ExitCode !== 0 || state.OOMKilled !== false) {
    test.kill('SIGTERM');
    await testExitPromise;
    throw new Error(
      `The worker did not stop cleanly: exit=${state.ExitCode}, oom=${state.OOMKilled}.`
    );
  }
  const logs = await output(
    'docker',
    ['logs', '--since', drillStartedAt, workerContainer],
    { includeStderr: true }
  );
  const localDriver = logs.includes('BYOK_GRID_LOCAL_WORKER_DRAIN_COMPLETE');
  const hatchetDriver = logs.includes('Successfully finished pending tasks.');
  if (!localDriver && !hatchetDriver) {
    test.kill('SIGTERM');
    await testExitPromise;
    throw new Error(
      'The worker log has no local or Hatchet pending-task drain confirmation.'
    );
  }
  if (logs.includes('Could not pause worker:')) {
    test.kill('SIGTERM');
    await testExitPromise;
    throw new Error(
      'The worker could not pause itself through the Hatchet API.'
    );
  }

  const testExit = await testExitPromise;
  if (testExit.code !== 0) {
    throw new Error(
      `The workflow E2E runner exited ${describeExit(testExit)}.`
    );
  }

  process.stdout.write(
    `${JSON.stringify({ marker: 'BYOK_GRID_DRAIN_DRILL_PASSED', rows: 500, steps: 100 })}\n`
  );
} finally {
  if (testProcess?.exitCode === null && testProcess.signalCode === null) {
    testProcess.kill('SIGTERM');
  }
  if (workerStopped) {
    await run('docker', [
      'compose',
      '--profile',
      'app',
      'up',
      '--detach',
      'workflow-worker',
    ]).catch((error) => {
      process.stderr.write(`Worker recovery failed: ${error.message}\n`);
      process.exitCode = 1;
    });
    await waitForWorkerHealth().catch((error) => {
      process.stderr.write(`Worker health recovery failed: ${error.message}\n`);
      process.exitCode = 1;
    });
    await verifyOperationalMetrics().catch((error) => {
      process.stderr.write(
        `Worker application metrics recovery failed: ${error.message}\n`
      );
      process.exitCode = 1;
    });
  }
}

async function stopWorker() {
  workerStopped = true;
  const startedAt = performance.now();
  await run('docker', [
    'compose',
    'stop',
    '--timeout',
    '90',
    'workflow-worker',
  ]);
  process.stdout.write(
    `${JSON.stringify({ drainMs: Math.round(performance.now() - startedAt), marker: 'BYOK_GRID_DRAIN_SIGNAL_COMPLETE' })}\n`
  );
}

async function waitForWorkerHealth() {
  const probe = [
    'compose',
    'exec',
    '--no-TTY',
    'workflow-worker',
    'node',
    'scripts/container/worker-health-probe.mjs',
    'ready',
  ];
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      await run('docker', probe, { quiet: true });
      return;
    } catch {
      // The local metrics server or Hatchet health server is still starting.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error('The worker did not become healthy within 30 seconds.');
}

async function verifyOperationalMetrics() {
  await run(
    'docker',
    [
      'compose',
      'exec',
      '--no-TTY',
      'workflow-worker',
      'node',
      '-e',
      "fetch('http://127.0.0.1:8002/metrics').then(async response => { const body = await response.text(); const required = ['byok_grid_workflow_runs', 'byok_grid_workflow_queue_oldest_age_seconds', 'byok_grid_outbox_unpublished_events']; process.exit(response.ok && required.every(name => body.includes(name)) ? 0 : 1) }).catch(() => process.exit(1))",
    ],
    { quiet: true }
  );
}

async function output(command, args, options = {}) {
  const chunks = [];
  await run(command, args, {
    onStderr: options.includeStderr ? (chunk) => chunks.push(chunk) : undefined,
    onStdout: (chunk) => chunks.push(chunk),
    quiet: true,
  });
  return Buffer.concat(chunks).toString().trim();
}

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    options.onStdout?.(chunk);
    if (!options.quiet) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk) => {
    options.onStderr?.(chunk);
    if (!options.quiet) process.stderr.write(chunk);
  });
  return childExit(child).then((exit) => {
    if (exit.code !== 0) {
      throw new Error(
        `${command} ${args[0] ?? ''} exited ${describeExit(exit)}.`
      );
    }
  });
}

function childExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.once('error', rejectPromise);
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

function describeExit(exit) {
  return exit.signal ? `from ${exit.signal}` : `with code ${exit.code}`;
}
