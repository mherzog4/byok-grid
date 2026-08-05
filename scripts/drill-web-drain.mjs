#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  isConnectionRejection,
  observeListenerClosure,
} from './drill-web-drain-lib.mjs';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const standaloneServer = join(
  repositoryRoot,
  'apps/web/.next/standalone/apps/web/server.js'
);
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), 'byok-grid-web-drain-')
);
let runtime;
let delayedRequest;

try {
  await access(standaloneServer).catch(() => {
    throw new Error(
      'The standalone web server is missing. Run npm run build before this drill.'
    );
  });

  runtime = await startRuntime();
  delayedRequest = await startDelayedRequest(runtime);

  const signalStartedAt = performance.now();
  if (!runtime.child.kill('SIGTERM')) {
    throw new Error('The standalone web process could not receive SIGTERM.');
  }

  const listenerCloseMilliseconds = await observeListenerClosure({
    canConnect: () => canConnect(runtime.port),
    isProcessExited: () =>
      runtime.child.exitCode !== null || runtime.child.signalCode !== null,
    isRequestSettled: delayedRequest.isSettled,
    startedAt: signalStartedAt,
  });
  const response = await delayedRequest.response();
  const status = response.status;
  if (status < 200 || status >= 500) {
    throw new Error(
      `The completed in-flight readiness request returned unexpected status ${status}.`
    );
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      response.headers.get('x-request-id') ?? ''
    )
  ) {
    throw new Error(
      'The completed in-flight request did not retain the application response contract.'
    );
  }
  await response.text();

  const exit = await runtime.waitForExit(10_000);
  if (exit.code !== 143 || exit.signal !== null) {
    throw new Error(
      `Next.js exited with code ${String(exit.code)} and signal ${String(exit.signal)}; expected its graceful SIGTERM exit code 143.`
    );
  }

  console.log(
    JSON.stringify({
      exitCode: exit.code,
      listenerCloseMilliseconds,
      marker: 'BYOK_GRID_WEB_DRAIN_DRILL_PASSED',
      newConnectionsRejectedBeforeCompletion: true,
      responseStatus: status,
    })
  );
} finally {
  delayedRequest?.destroy();
  await runtime?.forceStop();
  await rm(temporaryDirectory, { force: true, recursive: true });
}

async function startRuntime() {
  const databaseUrl = `file:${join(temporaryDirectory, 'web-drain.sqlite')}`;
  await run('npm', ['run', 'db:sqlite:migrate', '--workspace=@byok-grid/db'], {
    SQLITE_DATABASE_URL: databaseUrl,
  });

  const port = await availablePort();
  const localUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...process.env,
    BYOK_GRID_MASTER_KEY: Buffer.alloc(32, 11).toString('base64'),
    BYOK_GRID_MASTER_KEY_ID: 'drill-v1',
    BYOK_GRID_PUBLIC_URL: 'https://web-drain.example.test',
    BYOK_GRID_WEB_DRAIN_DRILL: '1',
    HOSTNAME: '127.0.0.1',
    NODE_ENV: 'production',
    PORT: String(port),
    SQLITE_DATABASE_URL: databaseUrl,
  };
  delete environment.NEXT_MANUAL_SIG_HANDLE;

  const child = spawn(process.execPath, [standaloneServer], {
    cwd: repositoryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  child.stderr.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const describeOutput = () => output;

  try {
    await waitUntilHealthy(localUrl, child, describeOutput);
  } catch (error) {
    child.kill('SIGKILL');
    await exited;
    throw error;
  }

  return {
    child,
    localUrl,
    port,
    waitForExit: (timeoutMilliseconds) =>
      Promise.race([
        exited,
        delay(timeoutMilliseconds, undefined, { ref: false }).then(() => {
          throw new Error(
            `The standalone web process did not exit after SIGTERM.\n${describeOutput()}`
          );
        }),
      ]),
    forceStop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
      await exited;
    },
  };
}

async function startDelayedRequest(input) {
  const controller = new AbortController();
  let settled = false;
  const startedAt = performance.now();
  const pendingResponse = fetch(`${input.localUrl}/api/health`, {
    headers: { 'x-byok-grid-drain-probe': '1' },
    signal: controller.signal,
  }).finally(() => {
    settled = true;
  });
  // Prevent an early request failure from becoming unhandled while the drill
  // is deliberately waiting inside the anti-enumeration response floor.
  pendingResponse.catch(() => undefined);

  await delay(100);
  if (settled) {
    controller.abort();
    throw new Error(
      'The readiness request did not enter the drain-probe delay.'
    );
  }

  return {
    destroy: () => controller.abort(),
    isSettled: () => settled,
    response: () =>
      Promise.race([
        pendingResponse.then((response) => {
          const elapsedMilliseconds = performance.now() - startedAt;
          if (elapsedMilliseconds < 450) {
            throw new Error(
              `The readiness response completed in ${Math.round(elapsedMilliseconds)}ms, below its expected drain-probe delay.`
            );
          }
          return response;
        }),
        delay(10_000, undefined, { ref: false }).then(() => {
          throw new Error(
            'The in-flight request did not complete during graceful shutdown.'
          );
        }),
      ]),
  };
}

function canConnect(port) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(100);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', (error) => {
      if (isConnectionRejection(error)) {
        resolve(false);
        return;
      }
      reject(error);
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(
        new Error(
          'A new connection timed out; listener closure could not be proven.'
        )
      );
    });
  });
}

async function waitUntilHealthy(localUrl, child, output) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`The web drain server exited early.\n${output()}`);
    }
    try {
      const response = await fetch(`${localUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The standalone listener may not be bound yet.
    }
    await delay(100);
  }
  throw new Error(`The web drain server did not become healthy.\n${output()}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a web drain drill port.');
  }
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function run(command, arguments_, extraEnvironment) {
  const child = spawn(command, arguments_, {
    cwd: repositoryRoot,
    env: { ...process.env, ...extraEnvironment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  child.stderr.on('data', (chunk) => {
    output = appendBounded(output, chunk);
  });
  const exitCode = await new Promise((resolve) => child.once('exit', resolve));
  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode}.\n${output}`);
  }
}

function appendBounded(current, chunk) {
  return `${current}${String(chunk)}`.slice(-8_000);
}
