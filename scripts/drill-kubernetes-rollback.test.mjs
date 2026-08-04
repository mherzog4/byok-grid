import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  KUBERNETES_ROLLBACK_EVIDENCE_MARKER,
  executeKubernetesRollbackDrill,
  helmRollbackArguments,
  inspectInitialHelmHistory,
  inspectRollbackWorkloads,
  parseRollbackEnvironment,
  validateHelmVersion,
  validateRollbackContext,
} from './drill-kubernetes-rollback-lib.mjs';

const environment = {
  BYOK_GRID_KUBERNETES_ROLLBACK_CONFIRM: 'controlled-production-candidate',
  BYOK_GRID_ROLLBACK_APP_ORIGIN: 'https://candidate.example.com',
  BYOK_GRID_ROLLBACK_CANDIDATE_DIGEST_MANIFEST: '/evidence/candidate.txt',
  BYOK_GRID_ROLLBACK_CANDIDATE_REVISION: '5',
  BYOK_GRID_ROLLBACK_CANDIDATE_SHA: 'a'.repeat(40),
  BYOK_GRID_ROLLBACK_CANDIDATE_VERSION: '0.1.0-rc.1',
  BYOK_GRID_ROLLBACK_CONTEXT: 'production-cluster',
  BYOK_GRID_ROLLBACK_NAMESPACE: 'byok-grid',
  BYOK_GRID_ROLLBACK_OPTIONAL_COMPONENTS: 'analytics-projector',
  BYOK_GRID_ROLLBACK_PREVIOUS_DIGEST_MANIFEST: '/evidence/previous.txt',
  BYOK_GRID_ROLLBACK_PREVIOUS_REVISION: '4',
  BYOK_GRID_ROLLBACK_PREVIOUS_VERSION: '0.0.9',
  BYOK_GRID_ROLLBACK_RELEASE: 'byok-grid',
};

describe('Kubernetes rollback drill', () => {
  it('requires an exact controlled target and immutable revision identities', () => {
    assert.deepEqual(parseRollbackEnvironment(environment), config());
    assert.throws(
      () =>
        parseRollbackEnvironment({
          ...environment,
          BYOK_GRID_KUBERNETES_ROLLBACK_CONFIRM: 'yes',
        }),
      /controlled-production-candidate/u
    );
    assert.throws(
      () =>
        parseRollbackEnvironment({
          ...environment,
          BYOK_GRID_ROLLBACK_APP_ORIGIN: 'https://127.0.0.1',
        }),
      /non-local/u
    );
    assert.throws(
      () =>
        parseRollbackEnvironment({
          ...environment,
          BYOK_GRID_ROLLBACK_PREVIOUS_REVISION: '6',
        }),
      /must precede/u
    );
    assert.throws(
      () =>
        parseRollbackEnvironment({
          ...environment,
          BYOK_GRID_ROLLBACK_OPTIONAL_COMPONENTS:
            'connector-runner,analytics-projector',
        }),
      /sorted unique/u
    );
    assert.throws(
      () =>
        parseRollbackEnvironment({
          ...environment,
          BYOK_GRID_ROLLBACK_CANDIDATE_VERSION: '0.1.0-rc.01',
        }),
      /canonical semantic version/u
    );
    assert.throws(
      () =>
        parseRollbackEnvironment({
          ...environment,
          BYOK_GRID_ROLLBACK_CANDIDATE_VERSION: '0.1.0',
        }),
      /must be a prerelease/u
    );
  });

  it('pins the supported Helm line and exact kubectl context', () => {
    assert.equal(validateHelmVersion('v4.2.3'), 'v4.2.3');
    assert.equal(validateHelmVersion('v4.8.1+gabcdef'), 'v4.8.1+gabcdef');
    assert.throws(() => validateHelmVersion('v3.19.0'), /Helm 4/u);
    assert.throws(() => validateHelmVersion('v4.2.2'), /4.2.3/u);
    assert.doesNotThrow(() =>
      validateRollbackContext('production-cluster\n', 'production-cluster')
    );
    assert.throws(
      () => validateRollbackContext('development', 'production-cluster'),
      /does not match/u
    );
  });

  it('uses the exact Helm 4 rollback safety flags', () => {
    assert.deepEqual(helmRollbackArguments(config(), 4), [
      'rollback',
      'byok-grid',
      '4',
      '--cleanup-on-fail',
      '--timeout=10m',
      '--wait=watcher',
    ]);
    assert.throws(
      () => helmRollbackArguments(config(), 0),
      /positive integer/u
    );
  });

  it('requires the named rollback point and candidate to match Helm history', () => {
    assert.deepEqual(
      inspectInitialHelmHistory(initialHistory(), config()).latest,
      {
        appVersion: '0.1.0-rc.1',
        revision: 5,
        status: 'deployed',
      }
    );
    const wrongCandidate = initialHistory();
    wrongCandidate[1].app_version = '0.2.0-rc.1';
    assert.throws(
      () => inspectInitialHelmHistory(wrongCandidate, config()),
      /currently deployed/u
    );
    const unsafeRollback = initialHistory();
    unsafeRollback[0].status = 'failed';
    assert.throws(
      () => inspectInitialHelmHistory(unsafeRollback, config()),
      /not a superseded/u
    );
  });

  it('binds stable Deployments and ready Pods to the exact image digests', () => {
    const candidate = manifest('1');
    assert.deepEqual(
      inspectRollbackWorkloads(resources(candidate), config(), candidate),
      [
        {
          component: 'analytics-projector',
          digest: `sha256:${'1'.repeat(64)}`,
          pods: 1,
          replicas: 1,
        },
        {
          component: 'web',
          digest: `sha256:${'1'.repeat(64)}`,
          pods: 2,
          replicas: 2,
        },
        {
          component: 'worker',
          digest: `sha256:${'1'.repeat(64)}`,
          pods: 1,
          replicas: 1,
        },
      ]
    );

    const restarted = resources(candidate);
    restarted.items.find(
      (item) => item.kind === 'Pod'
    ).status.containerStatuses[0].restartCount = 1;
    assert.throws(
      () => inspectRollbackWorkloads(restarted, config(), candidate),
      /healthy image digest/u
    );

    const mutable = resources(candidate);
    mutable.items.find(
      (item) => item.kind === 'Deployment'
    ).spec.template.spec.containers[0].image =
      'ghcr.io/mherzog4/byok-grid-analytics-projector:latest';
    assert.throws(
      () => inspectRollbackWorkloads(mutable, config(), candidate),
      /expected immutable image/u
    );
  });

  it('rolls back, verifies public health, and restores the exact candidate', async () => {
    const fixture = operationsFixture();
    const result = await executeKubernetesRollbackDrill({
      config: config(),
      manifests: fixture.manifests,
      now: () => new Date('2026-08-04T18:30:00.000Z'),
      operations: fixture.operations,
    });

    assert.deepEqual(fixture.rollbackCalls, [4, 5]);
    assert.equal(fixture.phase(), 'candidate-restored');
    assert.equal(result.marker, KUBERNETES_ROLLBACK_EVIDENCE_MARKER);
    assert.equal(result.helmVersion, 'v4.2.3');
    assert.equal(result.rollbackRevision, 6);
    assert.equal(result.restoredRevision, 7);
    assert.deepEqual(result.checks, {
      preflightPublicRequests: 4,
      restoredPublicRequests: 4,
      rollbackPublicRequests: 4,
    });
    assert.equal(result.verifiedAt, '2026-08-04T18:30:00.000Z');
  });

  it('requires rollback to change at least one enabled workload digest', async () => {
    const fixture = operationsFixture();
    fixture.manifests.previous = {
      byTarget: new Map(fixture.manifests.candidate.byTarget),
      sha256: 'f'.repeat(64),
    };
    await assert.rejects(
      executeKubernetesRollbackDrill({
        config: config(),
        manifests: fixture.manifests,
        operations: fixture.operations,
      }),
      /enabled workload digest must change/u
    );
    assert.deepEqual(fixture.rollbackCalls, []);
  });

  it('restores the candidate after a post-rollback verification failure', async () => {
    const fixture = operationsFixture({ failRollbackResources: true });
    await assert.rejects(
      executeKubernetesRollbackDrill({
        config: config(),
        manifests: fixture.manifests,
        operations: fixture.operations,
      }),
      /rollback workload verification failed/u
    );
    assert.deepEqual(fixture.rollbackCalls, [4, 5]);
    assert.equal(fixture.phase(), 'candidate-restored');
  });

  it('fails loudly when automatic candidate restoration cannot be verified', async () => {
    const fixture = operationsFixture({
      failCandidateRestore: true,
      failRollbackResources: true,
    });
    await assert.rejects(
      executeKubernetesRollbackDrill({
        config: config(),
        manifests: fixture.manifests,
        operations: fixture.operations,
      }),
      /manual recovery runbook/u
    );
    assert.deepEqual(fixture.rollbackCalls, [4, 5]);
  });
});

function config() {
  return {
    appOrigin: 'https://candidate.example.com',
    candidateCommit: 'a'.repeat(40),
    candidateDigestManifestPath: '/evidence/candidate.txt',
    candidateRevision: 5,
    candidateVersion: '0.1.0-rc.1',
    context: 'production-cluster',
    namespace: 'byok-grid',
    optionalComponents: ['analytics-projector'],
    previousDigestManifestPath: '/evidence/previous.txt',
    previousRevision: 4,
    previousVersion: '0.0.9',
    release: 'byok-grid',
    timeout: '10m',
  };
}

function manifest(character) {
  const digest = `sha256:${character.repeat(64)}`;
  const byTarget = new Map();
  for (const target of [
    'analytics-projector',
    'connector-runner',
    'web',
    'workflow-worker',
  ]) {
    byTarget.set(target, {
      digest,
      image: `ghcr.io/mherzog4/byok-grid-${target}@${digest}`,
    });
  }
  return { byTarget, sha256: character.repeat(64) };
}

function initialHistory() {
  return [
    { app_version: '0.0.9', revision: 4, status: 'superseded' },
    { app_version: '0.1.0-rc.1', revision: 5, status: 'deployed' },
  ];
}

function operationsFixture(options = {}) {
  const manifests = { candidate: manifest('1'), previous: manifest('2') };
  const rollbackCalls = [];
  let phase = 'candidate';
  return {
    manifests,
    operations: {
      currentContext: async () => 'production-cluster',
      helmVersion: async () => 'v4.2.3',
      history: async () => historyForPhase(phase),
      resources: async () => {
        if (phase === 'previous' && options.failRollbackResources) {
          throw new Error('rollback workload verification failed');
        }
        return resources(
          phase === 'previous' ? manifests.previous : manifests.candidate
        );
      },
      rollback: async (revision) => {
        rollbackCalls.push(revision);
        if (revision === 4) {
          phase = 'previous';
          return;
        }
        if (options.failCandidateRestore) {
          throw new Error('restore failed');
        }
        phase = 'candidate-restored';
      },
      verifyPublic: async () => ({
        marker: 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
        requests: 4,
      }),
    },
    phase: () => phase,
    rollbackCalls,
  };
}

function historyForPhase(phase) {
  const history = initialHistory();
  if (phase === 'candidate') return history;
  history[1].status = 'superseded';
  history.push({
    app_version: '0.0.9',
    revision: 6,
    status: phase === 'previous' ? 'deployed' : 'superseded',
  });
  if (phase === 'candidate-restored') {
    history.push({
      app_version: '0.1.0-rc.1',
      revision: 7,
      status: 'deployed',
    });
  }
  return history;
}

function resources(selectedManifest) {
  const items = [];
  for (const [component, replicas, target, container] of [
    ['analytics-projector', 1, 'analytics-projector', 'analytics-projector'],
    ['web', 2, 'web', 'web'],
    ['worker', 1, 'workflow-worker', 'worker'],
  ]) {
    const image = selectedManifest.byTarget.get(target).image;
    items.push({
      apiVersion: 'apps/v1',
      kind: 'Deployment',
      metadata: {
        generation: 3,
        labels: labels(component),
        name: `byok-grid-${component}`,
        namespace: 'byok-grid',
      },
      spec: {
        replicas,
        template: { spec: { containers: [{ image, name: container }] } },
      },
      status: {
        availableReplicas: replicas,
        observedGeneration: 3,
        readyReplicas: replicas,
        replicas,
        updatedReplicas: replicas,
      },
    });
    for (let index = 0; index < replicas; index += 1) {
      items.push({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: {
          labels: labels(component),
          name: `byok-grid-${component}-${index}`,
          namespace: 'byok-grid',
        },
        status: {
          conditions: [{ status: 'True', type: 'Ready' }],
          containerStatuses: [
            {
              image,
              imageID: `docker-pullable://${image}`,
              name: container,
              ready: true,
              restartCount: 0,
              state: { running: { startedAt: '2026-08-04T18:00:00Z' } },
            },
          ],
          phase: 'Running',
        },
      });
    }
  }
  return { apiVersion: 'v1', items, kind: 'List' };
}

function labels(component) {
  return {
    'app.kubernetes.io/component': component,
    'app.kubernetes.io/instance': 'byok-grid',
  };
}
