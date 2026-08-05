import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  KUBERNETES_SECRET_PROVENANCE_EVIDENCE_MARKER,
  buildKubernetesSecretProvenanceEvidence,
  inspectExternalSecret,
  inspectExternalSecretsControllerDeployment,
  inspectExternalSecretsControllerPods,
  inspectSecretStore,
  kubernetesLabelSelector,
  parseKubernetesSecretProvenanceEnvironment,
  validateKubernetesSecretContext,
} from './verify-kubernetes-secret-provenance-lib.mjs';

const CANDIDATE_COMMIT = 'a'.repeat(40);
const CONTROLLER_DIGEST = `sha256:${'b'.repeat(64)}`;
const CONTROLLER_IMAGE = `ghcr.io/external-secrets/external-secrets@${CONTROLLER_DIGEST}`;
const NOW = new Date('2026-08-04T18:00:00.000Z');
const SECRET_KEYS = [
  'byok-grid-master-key',
  'hatchet-client-token',
  'sqlite-auth-token',
  'sqlite-database-url',
];
let directory;

describe('Kubernetes external-secret provenance verifier', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'byok-grid-secret-provenance-'));
  });

  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  it('requires an explicit bounded production configuration', () => {
    assert.deepEqual(
      parseKubernetesSecretProvenanceEnvironment(environment()),
      {
        candidateCommit: CANDIDATE_COMMIT,
        context: 'candidate-cluster',
        controllerContainer: 'external-secrets',
        controllerDeployment: 'external-secrets',
        controllerDigest: CONTROLLER_DIGEST,
        controllerImage: CONTROLLER_IMAGE,
        controllerNamespace: 'external-secrets-system',
        expectedSecretKeys: SECRET_KEYS,
        externalSecretName: 'byok-grid',
        maxRefreshAgeSeconds: 7_200,
        namespace: 'byok-grid',
        storeKind: 'SecretStore',
        storeName: 'production-store',
      }
    );
    for (const mutation of [
      { BYOK_GRID_EXTERNAL_SECRET_VERIFY_CONFIRM: 'yes' },
      { BYOK_GRID_EXTERNAL_SECRET_CANDIDATE_SHA: 'A'.repeat(40) },
      { BYOK_GRID_EXTERNAL_SECRET_NAMESPACE: 'default' },
      {
        BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_NAMESPACE: 'byok-grid',
      },
      { BYOK_GRID_EXTERNAL_SECRET_STORE_KIND: 'VaultStaticSecret' },
      {
        BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_IMAGE:
          'ghcr.io/external-secrets/external-secrets:v1.2.3',
      },
      {
        BYOK_GRID_EXTERNAL_SECRET_EXPECTED_KEYS:
          'sqlite-database-url,unexpected-secret',
      },
      { BYOK_GRID_EXTERNAL_SECRET_MAX_REFRESH_AGE_SECONDS: '59' },
    ]) {
      assert.throws(() =>
        parseKubernetesSecretProvenanceEnvironment({
          ...environment(),
          ...mutation,
        })
      );
    }
    assert.doesNotThrow(() =>
      validateKubernetesSecretContext(
        'candidate-cluster\n',
        'candidate-cluster'
      )
    );
    assert.throws(() =>
      validateKubernetesSecretContext('production', 'candidate-cluster')
    );
  });

  it('accepts one recent explicit ExternalSecret v1 sync', () => {
    const config = configuration();
    const result = inspectExternalSecret(externalSecretFixture(), config, NOW);
    assert.equal(result.externalSecretGeneration, 3);
    assert.equal(result.refreshIntervalSeconds, 3_600);
    assert.equal(result.refreshTime, '2026-08-04T17:30:00.000Z');
    assert.equal(result.secretKeyCount, 4);
    assert.equal(result.secretReferenceSha256, sha256('byok-grid-secrets'));
    for (const value of Object.values(result)) {
      assert.doesNotMatch(String(value), /production\/byok-grid/u);
    }
  });

  it('rejects broad, stale, unsafe, transformed, or drifted secret syncs', () => {
    const config = configuration();
    const mutations = [
      (value) => (value.apiVersion = 'external-secrets.io/v1beta1'),
      (value) => (value.spec.refreshPolicy = 'OnChange'),
      (value) => (value.spec.refreshInterval = '25h'),
      (value) => (value.spec.target.creationPolicy = 'Merge'),
      (value) => (value.spec.target.deletionPolicy = 'Delete'),
      (value) => (value.spec.target.template = { data: { extra: 'unsafe' } }),
      (value) =>
        (value.spec.dataFrom = [{ extract: { key: 'production/byok-grid' } }]),
      (value) => (value.spec.data[0].secretKey = 'unexpected-key'),
      (value) => (value.spec.data[0].remoteRef.decodingStrategy = 'Base64'),
      (value) => (value.spec.unknown = true),
      (value) => (value.status.refreshTime = '2026-08-04T14:00:00.000Z'),
      (value) => (value.status.syncedResourceVersion = ''),
      (value) => (value.status.syncedResourceVersion = '2-stale'),
      (value) => (value.status.conditions[0].status = 'False'),
      (value) => (value.status.conditions[0].reason = 'SecretSyncedError'),
      (value) => (value.metadata.deletionTimestamp = NOW.toISOString()),
    ];
    for (const mutate of mutations) {
      const value = externalSecretFixture();
      mutate(value);
      assert.throws(() => inspectExternalSecret(value, config, NOW));
    }
  });

  it('requires a tight refresh-age envelope and canonical duration', () => {
    const value = externalSecretFixture();
    value.spec.refreshInterval = '90m';
    assert.throws(() => inspectExternalSecret(value, configuration(), NOW));
    value.spec.refreshInterval = '1h0m0s';
    assert.throws(() =>
      inspectExternalSecret(
        value,
        configuration({ maxRefreshAgeSeconds: 8_000 }),
        NOW
      )
    );
    assert.doesNotThrow(() =>
      inspectExternalSecret(
        value,
        configuration({ maxRefreshAgeSeconds: 7_500 }),
        NOW
      )
    );
  });

  it('accepts only one healthy declared v1 SecretStore provider', () => {
    const config = configuration();
    assert.deepEqual(inspectSecretStore(secretStoreFixture(), config, NOW), {
      secretStoreGeneration: 2,
      secretStoreSpecSha256: sha256(canonicalJson(secretStoreFixture().spec)),
    });
    for (const mutate of [
      (value) => (value.apiVersion = 'external-secrets.io/v1beta1'),
      (value) => (value.kind = 'ClusterSecretStore'),
      (value) => (value.metadata.namespace = 'other'),
      (value) => (value.metadata.deletionTimestamp = NOW.toISOString()),
      (value) => (value.spec.provider.aws = {}),
      (value) => (value.status.conditions[0].status = 'False'),
      (value) =>
        (value.status.conditions[0].lastTransitionTime =
          '2026-08-04T19:00:00.000Z'),
    ]) {
      const value = secretStoreFixture();
      mutate(value);
      assert.throws(() => inspectSecretStore(value, config, NOW));
    }
  });

  it('supports a cluster-scoped store without weakening identity checks', () => {
    const config = configuration({ storeKind: 'ClusterSecretStore' });
    const store = secretStoreFixture();
    store.kind = 'ClusterSecretStore';
    delete store.metadata.namespace;
    const external = externalSecretFixture();
    external.spec.secretStoreRef.kind = 'ClusterSecretStore';
    assert.equal(
      inspectSecretStore(store, config, NOW).secretStoreGeneration,
      2
    );
    assert.match(
      inspectExternalSecret(external, config, NOW).storeReferenceSha256,
      /^[0-9a-f]{64}$/u
    );
  });

  it('requires a stable digest-pinned hardened controller Deployment', () => {
    const config = configuration();
    const result = inspectExternalSecretsControllerDeployment(
      deploymentFixture(),
      config
    );
    assert.deepEqual(result, {
      matchLabels: {
        'app.kubernetes.io/instance': 'external-secrets',
        'app.kubernetes.io/name': 'external-secrets',
      },
      replicas: 2,
      serviceAccountName: 'external-secrets',
    });
    for (const mutate of [
      (value) => (value.spec.template.spec.containers[0].image = 'mutable:v1'),
      (value) => (value.status.readyReplicas = 1),
      (value) => (value.spec.template.spec.serviceAccountName = 'default'),
      (value) => (value.spec.template.spec.hostNetwork = true),
      (value) =>
        (value.spec.template.spec.volumes = [
          { host: { hostPath: { path: '/' } }, hostPath: { path: '/' } },
        ]),
      (value) =>
        (value.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem = false),
      (value) =>
        value.spec.template.spec.containers.push({
          image: CONTROLLER_IMAGE,
          name: 'sidecar',
        }),
      (value) =>
        (value.spec.template.spec.initContainers = [
          { image: CONTROLLER_IMAGE, name: 'initializer' },
        ]),
      (value) =>
        (value.spec.template.metadata.labels['app.kubernetes.io/instance'] =
          'other'),
    ]) {
      const value = deploymentFixture();
      mutate(value);
      assert.throws(() =>
        inspectExternalSecretsControllerDeployment(value, config)
      );
    }
  });

  it('binds every Ready restart-free controller Pod to the immutable digest', () => {
    const config = configuration();
    const deployment = inspectExternalSecretsControllerDeployment(
      deploymentFixture(),
      config
    );
    assert.deepEqual(
      inspectExternalSecretsControllerPods(
        podListFixture(),
        config,
        deployment
      ),
      { controllerPods: 2 }
    );
    for (const mutate of [
      (value) => value.items.pop(),
      (value) => (value.items[0].status.phase = 'Pending'),
      (value) => (value.items[0].status.conditions[0].status = 'False'),
      (value) => (value.items[0].status.containerStatuses[0].restartCount = 1),
      (value) =>
        (value.items[0].status.containerStatuses[0].imageID = `containerd://sha256:${'c'.repeat(64)}`),
      (value) =>
        (value.items[0].metadata.labels['app.kubernetes.io/instance'] =
          'other'),
      (value) =>
        (value.items[0].spec.containers[0].securityContext.readOnlyRootFilesystem = false),
      (value) =>
        (value.items[0].spec.ephemeralContainers = [
          { image: CONTROLLER_IMAGE, name: 'debugger' },
        ]),
      (value) => (value.items[0].spec.serviceAccountName = 'other'),
    ]) {
      const value = podListFixture();
      mutate(value);
      assert.throws(() =>
        inspectExternalSecretsControllerPods(value, config, deployment)
      );
    }
  });

  it('emits one sanitized candidate-bound evidence record', () => {
    const config = configuration();
    const externalSecret = inspectExternalSecret(
      externalSecretFixture(),
      config,
      NOW
    );
    const store = inspectSecretStore(secretStoreFixture(), config, NOW);
    const deployment = inspectExternalSecretsControllerDeployment(
      deploymentFixture(),
      config
    );
    const controller = inspectExternalSecretsControllerPods(
      podListFixture(),
      config,
      deployment
    );
    const evidence = buildKubernetesSecretProvenanceEvidence({
      config,
      controller,
      externalSecret,
      now: NOW,
      store,
    });
    assert.equal(evidence.marker, KUBERNETES_SECRET_PROVENANCE_EVIDENCE_MARKER);
    assert.equal(evidence.candidateCommit, CANDIDATE_COMMIT);
    assert.equal(evidence.controllerDigest, CONTROLLER_DIGEST);
    assert.equal(evidence.controllerPods, 2);
    assert.equal(evidence.secretKeyCount, 4);
    assert.equal(evidence.verifiedAt, NOW.toISOString());
    const serialized = JSON.stringify(evidence);
    for (const secret of [
      'byok-grid-secrets',
      'production/byok-grid',
      'production-store',
      'external-secrets-system/external-secrets',
      'vault.example.net',
    ]) {
      assert.equal(serialized.includes(secret), false);
    }
  });

  it('serializes a safe deterministic controller selector', () => {
    assert.equal(
      kubernetesLabelSelector({ z: 'last', a: 'first' }),
      'a=first,z=last'
    );
  });

  it('orchestrates only bounded read-only non-Secret requests', () => {
    const fixtureDirectory = join(directory, 'fixtures');
    const binaryDirectory = join(directory, 'bin');
    mkdirSync(fixtureDirectory, { recursive: true });
    const liveExternalSecret = externalSecretFixture();
    liveExternalSecret.status.conditions[0].lastTransitionTime = new Date(
      Date.now() - 60 * 60 * 1_000
    ).toISOString();
    liveExternalSecret.status.refreshTime = new Date(
      Date.now() - 30 * 60 * 1_000
    ).toISOString();
    const fixturePaths = {
      deployment: writeJsonFixture(
        fixtureDirectory,
        'deployment.json',
        deploymentFixture()
      ),
      external: writeJsonFixture(
        fixtureDirectory,
        'external.json',
        liveExternalSecret
      ),
      pods: writeJsonFixture(fixtureDirectory, 'pods.json', podListFixture()),
      store: writeJsonFixture(
        fixtureDirectory,
        'store.json',
        secretStoreFixture()
      ),
    };
    const callsPath = join(directory, 'calls.jsonl');
    writeExecutable(join(binaryDirectory, 'kubectl'), fakeKubectlSource());
    const result = spawnSync(
      process.execPath,
      ['scripts/verify-kubernetes-secret-provenance.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...environment(),
          FAKE_CALLS_PATH: callsPath,
          FAKE_DEPLOYMENT_PATH: fixturePaths.deployment,
          FAKE_EXTERNAL_PATH: fixturePaths.external,
          FAKE_PODS_PATH: fixturePaths.pods,
          FAKE_STORE_PATH: fixturePaths.store,
          PATH: `${binaryDirectory}:${process.env.PATH}`,
        },
        timeout: 10_000,
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.marker, KUBERNETES_SECRET_PROVENANCE_EVIDENCE_MARKER);
    assert.doesNotMatch(
      result.stdout,
      /byok-grid-secrets|production\/byok-grid/u
    );
    const calls = readFileSync(callsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 5);
    assert.equal(
      calls.some((args) =>
        args.some((arg) => ['secret', 'secrets'].includes(arg))
      ),
      false
    );
    assert.equal(
      calls.every(
        (args) => !args.includes('create') && !args.includes('delete')
      ),
      true
    );
  });

  it('keeps supplied names out of failures and runtime imports dependency-free', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/verify-kubernetes-secret-provenance.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...environment({
            BYOK_GRID_EXTERNAL_SECRET_NAME: 'private-secret-controller-name',
          }),
          PATH: '/definitely-missing',
        },
      }
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /private-secret-controller-name/u);
    for (const path of [
      'scripts/verify-kubernetes-secret-provenance-lib.mjs',
      'scripts/verify-kubernetes-secret-provenance.mjs',
    ]) {
      assert.doesNotMatch(readFileSync(path, 'utf8'), /from ['"](?!node:|\.)/u);
    }
  });
});

function environment(overrides = {}) {
  return {
    BYOK_GRID_EXTERNAL_SECRET_VERIFY_CONFIRM:
      'read-only-external-secret-candidate',
    BYOK_GRID_EXTERNAL_SECRET_CANDIDATE_SHA: CANDIDATE_COMMIT,
    BYOK_GRID_EXTERNAL_SECRET_CONTEXT: 'candidate-cluster',
    BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_CONTAINER: 'external-secrets',
    BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_DEPLOYMENT: 'external-secrets',
    BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_IMAGE: CONTROLLER_IMAGE,
    BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_NAMESPACE: 'external-secrets-system',
    BYOK_GRID_EXTERNAL_SECRET_EXPECTED_KEYS: SECRET_KEYS.join(','),
    BYOK_GRID_EXTERNAL_SECRET_NAME: 'byok-grid',
    BYOK_GRID_EXTERNAL_SECRET_NAMESPACE: 'byok-grid',
    BYOK_GRID_EXTERNAL_SECRET_STORE_KIND: 'SecretStore',
    BYOK_GRID_EXTERNAL_SECRET_STORE_NAME: 'production-store',
    ...overrides,
  };
}

function configuration(overrides = {}) {
  return {
    ...parseKubernetesSecretProvenanceEnvironment(environment()),
    ...overrides,
  };
}

function externalSecretFixture() {
  return {
    apiVersion: 'external-secrets.io/v1',
    kind: 'ExternalSecret',
    metadata: {
      generation: 3,
      name: 'byok-grid',
      namespace: 'byok-grid',
      resourceVersion: '100',
    },
    spec: {
      data: SECRET_KEYS.map((secretKey) => ({
        remoteRef: {
          conversionStrategy: 'Default',
          decodingStrategy: 'None',
          key: `production/byok-grid/${secretKey}`,
          metadataPolicy: 'None',
        },
        secretKey,
      })),
      refreshInterval: '1h0m0s',
      refreshPolicy: 'Periodic',
      secretStoreRef: { kind: 'SecretStore', name: 'production-store' },
      target: {
        creationPolicy: 'Owner',
        deletionPolicy: 'Retain',
        name: 'byok-grid-secrets',
      },
    },
    status: {
      binding: { name: 'byok-grid-secrets' },
      conditions: [
        {
          lastTransitionTime: '2026-08-04T17:00:00.000Z',
          message: 'Secret was synced',
          reason: 'SecretSynced',
          status: 'True',
          type: 'Ready',
        },
      ],
      refreshTime: '2026-08-04T17:30:00.000Z',
      syncedResourceVersion: '3-1d154fbb',
    },
  };
}

function secretStoreFixture() {
  return {
    apiVersion: 'external-secrets.io/v1',
    kind: 'SecretStore',
    metadata: {
      generation: 2,
      name: 'production-store',
      namespace: 'byok-grid',
      resourceVersion: '90',
    },
    spec: {
      provider: {
        vault: {
          auth: {
            kubernetes: {
              mountPath: 'kubernetes',
              role: 'byok-grid',
              serviceAccountRef: { name: 'external-secrets-reader' },
            },
          },
          path: 'kv',
          server: 'https://vault.example.net',
          version: 'v2',
        },
      },
      refreshInterval: 3_600,
    },
    status: {
      capabilities: 'ReadWrite',
      conditions: [
        {
          lastTransitionTime: '2026-08-04T16:00:00.000Z',
          reason: 'Valid',
          status: 'True',
          type: 'Ready',
        },
      ],
    },
  };
}

function deploymentFixture() {
  const labels = {
    'app.kubernetes.io/instance': 'external-secrets',
    'app.kubernetes.io/name': 'external-secrets',
  };
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: {
      generation: 4,
      name: 'external-secrets',
      namespace: 'external-secrets-system',
    },
    spec: {
      replicas: 2,
      selector: { matchLabels: labels },
      template: {
        metadata: { labels: { ...labels } },
        spec: controllerPodSpec(),
      },
    },
    status: {
      availableReplicas: 2,
      observedGeneration: 4,
      readyReplicas: 2,
      replicas: 2,
      updatedReplicas: 2,
    },
  };
}

function podListFixture() {
  return {
    apiVersion: 'v1',
    items: [
      controllerPod('external-secrets-1'),
      controllerPod('external-secrets-2'),
    ],
    kind: 'List',
    metadata: { resourceVersion: '' },
  };
}

function controllerPod(name) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      labels: {
        'app.kubernetes.io/instance': 'external-secrets',
        'app.kubernetes.io/name': 'external-secrets',
      },
      name,
      namespace: 'external-secrets-system',
    },
    spec: controllerPodSpec(),
    status: {
      conditions: [{ status: 'True', type: 'Ready' }],
      containerStatuses: [
        {
          image: CONTROLLER_IMAGE,
          imageID: `containerd://${CONTROLLER_DIGEST}`,
          name: 'external-secrets',
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: '2026-08-04T16:00:00.000Z' } },
        },
      ],
      phase: 'Running',
    },
  };
}

function controllerPodSpec() {
  return {
    containers: [
      {
        image: CONTROLLER_IMAGE,
        name: 'external-secrets',
        securityContext: {
          allowPrivilegeEscalation: false,
          capabilities: { drop: ['ALL'] },
          privileged: false,
          readOnlyRootFilesystem: true,
          runAsNonRoot: true,
        },
      },
    ],
    securityContext: { seccompProfile: { type: 'RuntimeDefault' } },
    serviceAccountName: 'external-secrets',
  };
}

function writeJsonFixture(parent, name, value) {
  const path = join(parent, name);
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  return path;
}

function writeExecutable(path, source) {
  mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

function fakeKubectlSource() {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_CALLS_PATH, JSON.stringify(args) + '\\n');
if (args.includes('current-context')) {
  process.stdout.write('candidate-cluster\\n');
  process.exit(0);
}
const resource = args[args.indexOf('get') + 1];
const paths = {
  'externalsecret.external-secrets.io': process.env.FAKE_EXTERNAL_PATH,
  'secretstore.external-secrets.io': process.env.FAKE_STORE_PATH,
  'deployment.apps': process.env.FAKE_DEPLOYMENT_PATH,
  pods: process.env.FAKE_PODS_PATH,
};
if (!paths[resource]) process.exit(2);
process.stdout.write(fs.readFileSync(paths[resource], 'utf8'));
`;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
