import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  extractInFlightMarker,
  inspectRestartedWorkerPod,
  inspectSingleReadyWorkerPod,
  inspectWorkerDeployment,
  parseDrainEnvironment,
  validateCurrentContext,
  validateDrainLogs,
} from './drill-kubernetes-workflow-drain-lib.mjs';

const environment = {
  BYOK_GRID_DRILL_APP_ORIGIN: 'https://preproduction.example.com',
  BYOK_GRID_DRILL_DATABASE_AUTH_TOKEN: 'secret-auth-token',
  BYOK_GRID_DRILL_DATABASE_URL: 'libsql://preproduction-db.example.com',
  BYOK_GRID_DRILL_KUBECTL_CONTEXT: 'preproduction-cluster',
  BYOK_GRID_DRILL_NAMESPACE: 'byok-grid-drill',
  BYOK_GRID_DRILL_WORKER_DEPLOYMENT: 'byok-grid-worker',
  BYOK_GRID_KUBERNETES_DRAIN_CONFIRM: 'isolated-preproduction-environment',
};

describe('authenticated Kubernetes workflow drain drill', () => {
  it('targets the chart-owned worker deployment and container names', () => {
    const template = readFileSync(
      new URL(
        '../deploy/helm/byok-grid/templates/worker-deployment.yaml',
        import.meta.url
      ),
      'utf8'
    );
    assert.match(
      template,
      /name: \{\{ include "byok-grid\.fullname" \. \}\}-worker/u
    );
    assert.match(template, /containers:\s+- name: worker/u);
    assert.equal(
      environment.BYOK_GRID_DRILL_WORKER_DEPLOYMENT,
      'byok-grid-worker'
    );
  });

  it('requires exact confirmation and canonical remote endpoints', () => {
    assert.deepEqual(parseDrainEnvironment(environment), {
      appOrigin: 'https://preproduction.example.com',
      context: 'preproduction-cluster',
      databaseAuthToken: 'secret-auth-token',
      databaseUrl: 'libsql://preproduction-db.example.com',
      deployment: 'byok-grid-worker',
      namespace: 'byok-grid-drill',
      timeoutMs: 120_000,
    });
    assert.throws(
      () =>
        parseDrainEnvironment({
          ...environment,
          BYOK_GRID_KUBERNETES_DRAIN_CONFIRM: 'yes',
        }),
      /isolated-preproduction-environment/u
    );
    for (const appOrigin of [
      'http://preproduction.example.com',
      'https://user:password@preproduction.example.com',
      'https://preproduction.example.com/path',
      'https://127.0.0.1',
      'https://localhost',
    ]) {
      assert.throws(() =>
        parseDrainEnvironment({
          ...environment,
          BYOK_GRID_DRILL_APP_ORIGIN: appOrigin,
        })
      );
    }
    for (const databaseUrl of [
      'file:local.sqlite',
      'https://preproduction-db.example.com',
      'libsql://user:password@preproduction-db.example.com',
      'libsql://preproduction-db.example.com/path',
      'libsql://127.0.0.1',
      'libsql://[::1]',
    ]) {
      assert.throws(() =>
        parseDrainEnvironment({
          ...environment,
          BYOK_GRID_DRILL_DATABASE_URL: databaseUrl,
        })
      );
    }
    assert.throws(() =>
      parseDrainEnvironment({
        ...environment,
        BYOK_GRID_DRILL_NAMESPACE: 'invalid.namespace',
      })
    );
  });

  it('does not print supplied credentials when validation fails', () => {
    const authToken = 'drill-secret-auth-token-sentinel';
    const result = spawnSync(
      process.execPath,
      [
        new URL('./drill-kubernetes-workflow-drain.mjs', import.meta.url)
          .pathname,
      ],
      {
        encoding: 'utf8',
        env: {
          ...environment,
          BYOK_GRID_DRILL_APP_ORIGIN:
            'https://embedded-secret@preproduction.example.com',
          BYOK_GRID_DRILL_DATABASE_AUTH_TOKEN: authToken,
          PATH: process.env.PATH,
        },
      }
    );
    assert.equal(result.status, 1);
    const output = `${result.stdout}${result.stderr}`;
    assert.equal(output.includes(authToken), false);
    assert.equal(output.includes('embedded-secret'), false);
  });

  it('orchestrates an in-flight signal, clean restart, health, and idle proof', () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'byok-grid-kubernetes-drill-')
    );
    const stateFile = join(temporaryDirectory, 'restart-state');
    const kubectlPath = join(temporaryDirectory, 'kubectl');
    const npmPath = join(temporaryDirectory, 'npm');
    const originalPod = podListFixture();
    const restartedPod = podListFixture({
      lastState: { terminated: { exitCode: 0, reason: 'Completed' } },
      restartCount: 4,
    });
    writeExecutable(
      kubectlPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
const state = process.env.FAKE_KUBECTL_STATE;
if (args.includes('config current-context')) process.stdout.write('preproduction-cluster\\n');
else if (args.includes('get deployment')) process.stdout.write(${JSON.stringify(JSON.stringify(deploymentFixture()))});
else if (args.includes('get pods')) process.stdout.write(fs.existsSync(state) ? ${JSON.stringify(JSON.stringify(restartedPod))} : ${JSON.stringify(JSON.stringify(originalPod))});
else if (args.includes('8001/health')) process.stdout.write(JSON.stringify({ status: 'HEALTHY' }));
else if (args.includes('8002/metrics')) process.stdout.write(JSON.stringify({ idle: true }));
else if (args.includes("process.kill(1, 'SIGTERM')")) { fs.writeFileSync(state, 'restarted'); process.exitCode = 1; }
else if (args.includes('logs') && args.includes('--previous')) process.stdout.write('Successfully finished pending tasks.\\n');
else process.exitCode = 1;
`
    );
    writeExecutable(
      npmPath,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ marker: 'BYOK_GRID_DRAIN_DRILL_IN_FLIGHT', rowCount: 500, runId: '3f142da7-b50c-42d0-a7fb-bb012492770c' }) + '\\n');
setTimeout(() => process.exit(0), 250);
`
    );

    try {
      const result = spawnSync(
        process.execPath,
        [
          new URL('./drill-kubernetes-workflow-drain.mjs', import.meta.url)
            .pathname,
        ],
        {
          encoding: 'utf8',
          env: {
            ...environment,
            FAKE_KUBECTL_STATE: stateFile,
            PATH: `${temporaryDirectory}:${process.env.PATH ?? ''}`,
          },
          timeout: 15_000,
        }
      );
      assert.equal(result.status, 0, result.stderr);
      const evidence = JSON.parse(result.stdout.trim());
      assert.deepEqual(evidence, {
        context: 'preproduction-cluster',
        deployment: 'byok-grid-worker',
        drainMs: evidence.drainMs,
        elapsedMs: evidence.elapsedMs,
        marker: 'BYOK_GRID_KUBERNETES_WORKER_DRAIN_VERIFIED',
        namespace: 'byok-grid-drill',
        podUid: 'pod-uid',
        restartCount: 4,
        rowCount: 500,
        runId: '3f142da7-b50c-42d0-a7fb-bb012492770c',
        signal: 'SIGTERM',
        verifiedAt: evidence.verifiedAt,
      });
      assert.equal(Number.isInteger(evidence.elapsedMs), true);
      assert.equal(Number.isInteger(evidence.drainMs), true);
      assert.equal(evidence.drainMs <= 90_000, true);
      assert.match(evidence.verifiedAt, /^\d{4}-\d{2}-\d{2}T/u);
      assert.equal(result.stdout.includes('secret-auth-token'), false);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('requires the explicitly named kubectl context', () => {
    assert.doesNotThrow(() =>
      validateCurrentContext('preproduction-cluster\n', 'preproduction-cluster')
    );
    assert.throws(
      () => validateCurrentContext('production', 'preproduction-cluster'),
      /does not match/u
    );
  });

  it('accepts only a stable one-replica worker deployment with drain grace', () => {
    const deployment = deploymentFixture();
    assert.deepEqual(inspectWorkerDeployment(deployment), {
      selector:
        'app.kubernetes.io/component=worker,app.kubernetes.io/name=byok-grid',
      terminationGracePeriodSeconds: 90,
    });
    assert.throws(
      () =>
        inspectWorkerDeployment({
          ...deployment,
          spec: { ...deployment.spec, replicas: 2 },
        }),
      /exactly one replica/u
    );
    assert.throws(
      () =>
        inspectWorkerDeployment({
          ...deployment,
          spec: {
            ...deployment.spec,
            template: {
              spec: {
                ...deployment.spec.template.spec,
                terminationGracePeriodSeconds: 89,
              },
            },
          },
        }),
      /at least 90 seconds/u
    );
  });

  it('proves the same pod restarted exactly once and exited cleanly', () => {
    const originalList = podListFixture();
    const original = inspectSingleReadyWorkerPod(originalList);
    assert.deepEqual(original, {
      name: 'worker-abc',
      restartCount: 3,
      uid: 'pod-uid',
    });

    const restarted = podListFixture({
      lastState: { terminated: { exitCode: 0, reason: 'Completed' } },
      restartCount: 4,
    });
    assert.deepEqual(inspectRestartedWorkerPod(restarted, original), {
      name: 'worker-abc',
      restartCount: 4,
      uid: 'pod-uid',
    });
    assert.throws(
      () =>
        inspectRestartedWorkerPod(
          podListFixture({
            lastState: { terminated: { exitCode: 137, reason: 'Error' } },
            restartCount: 4,
          }),
          original
        ),
      /clean completed exit/u
    );
  });

  it('extracts only the fixed 500-row in-flight marker', () => {
    const runId = '3f142da7-b50c-42d0-a7fb-bb012492770c';
    assert.deepEqual(
      extractInFlightMarker(
        `stdout | workflow\n${JSON.stringify({ marker: 'BYOK_GRID_DRAIN_DRILL_IN_FLIGHT', rowCount: 500, runId })}\n`
      ),
      { rowCount: 500, runId }
    );
    assert.equal(
      extractInFlightMarker(
        JSON.stringify({
          marker: 'BYOK_GRID_DRAIN_DRILL_IN_FLIGHT',
          rowCount: 499,
          runId,
        })
      ),
      undefined
    );
  });

  it('requires positive drain logs and rejects Hatchet pause failure', () => {
    assert.doesNotThrow(() =>
      validateDrainLogs('Successfully finished pending tasks.')
    );
    assert.throws(
      () =>
        validateDrainLogs(
          'Could not pause worker: unavailable\nSuccessfully finished pending tasks.'
        ),
      /could not pause/u
    );
  });
});

function deploymentFixture() {
  return {
    metadata: { generation: 7 },
    spec: {
      replicas: 1,
      selector: {
        matchLabels: {
          'app.kubernetes.io/name': 'byok-grid',
          'app.kubernetes.io/component': 'worker',
        },
      },
      template: {
        spec: {
          containers: [{ name: 'worker' }],
          terminationGracePeriodSeconds: 90,
        },
      },
    },
    status: {
      availableReplicas: 1,
      observedGeneration: 7,
      readyReplicas: 1,
      replicas: 1,
      updatedReplicas: 1,
    },
  };
}

function podListFixture(overrides = {}) {
  return {
    items: [
      {
        metadata: { name: 'worker-abc', uid: 'pod-uid' },
        status: {
          conditions: [{ status: 'True', type: 'Ready' }],
          containerStatuses: [
            {
              lastState: {},
              name: 'worker',
              ready: true,
              restartCount: 3,
              state: { running: { startedAt: '2026-08-03T00:00:00Z' } },
              ...overrides,
            },
          ],
          phase: 'Running',
        },
      },
    ],
  };
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}
