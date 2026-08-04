import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  KUBERNETES_RUNTIME_EVIDENCE_MARKER,
  parseKubernetesVerificationEnvironment,
  parseReleaseDigestManifest,
  readReleaseDigestManifest,
  verifyKubernetesRuntime,
} from './verify-kubernetes-runtime-lib.mjs';

const CANDIDATE_COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-08-04T16:00:00.000Z');
const RELEASE = 'byok-grid';
const NAMESPACE = 'production';
const SECRET = 'byok-grid-runtime';
const IMAGE_NAMES = [
  'byok-grid-airbyte-destination',
  'byok-grid-analytics-projector',
  'byok-grid-connector-runner',
  'byok-grid-maintenance',
  'byok-grid-migration',
  'byok-grid-web',
  'byok-grid-workflow-worker',
];
const DIGEST_SOURCE = `${IMAGE_NAMES.map(
  (name, index) =>
    `ghcr.io/example/${name}@sha256:${String(index + 1).repeat(64)}`
).join('\n')}\n`;
const MANIFEST = parseReleaseDigestManifest(DIGEST_SOURCE);
let directory;

describe('Kubernetes production runtime verifier', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'byok-grid-kubernetes-runtime-'));
  });

  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  it('accepts only an explicit bounded production-candidate environment', () => {
    const parsed = parseKubernetesVerificationEnvironment(environment());
    assert.deepEqual(parsed, {
      candidateCommit: CANDIDATE_COMMIT,
      context: 'production-cluster',
      digestManifestPath: '/operator/IMAGE_DIGESTS.txt',
      namespace: NAMESPACE,
      optionalComponents: [],
      origin: 'https://grid.example.com',
      release: RELEASE,
    });

    for (const mutation of [
      { BYOK_GRID_KUBERNETES_VERIFY_CONFIRM: 'yes' },
      { BYOK_GRID_KUBERNETES_CANDIDATE_SHA: 'A'.repeat(40) },
      { BYOK_GRID_KUBERNETES_NAMESPACE: 'Production' },
      { BYOK_GRID_KUBERNETES_APP_ORIGIN: 'http://grid.example.com' },
      {
        BYOK_GRID_KUBERNETES_OPTIONAL_COMPONENTS:
          'connector-runner,analytics-projector',
      },
    ]) {
      assert.throws(() =>
        parseKubernetesVerificationEnvironment({
          ...environment(),
          ...mutation,
        })
      );
    }
  });

  it('requires the canonical complete immutable release image set', () => {
    assert.equal(MANIFEST.byTarget.size, 7);
    assert.match(MANIFEST.sha256, /^[0-9a-f]{64}$/u);
    for (const source of [
      DIGEST_SOURCE.trimEnd(),
      DIGEST_SOURCE.replace('@sha256:', ':latest@sha256:'),
      DIGEST_SOURCE.split('\n').slice(1).join('\n'),
      DIGEST_SOURCE.replace(IMAGE_NAMES[1], IMAGE_NAMES[0]),
    ]) {
      assert.throws(() => parseReleaseDigestManifest(source));
    }

    const manifestPath = join(directory, 'IMAGE_DIGESTS.txt');
    const linkPath = join(directory, 'private-image-token');
    writeFileSync(manifestPath, DIGEST_SOURCE);
    symlinkSync(manifestPath, linkPath);
    assert.throws(
      () => readReleaseDigestManifest(linkPath),
      (error) => {
        assert.doesNotMatch(String(error), /private-image-token/u);
        return true;
      }
    );
  });

  it('binds stable live workloads and pod image IDs to the release manifest', () => {
    const result = verifyKubernetesRuntime(snapshot(), options());
    assert.equal(result.marker, KUBERNETES_RUNTIME_EVIDENCE_MARKER);
    assert.equal(result.candidateCommit, CANDIDATE_COMMIT);
    assert.equal(result.clusterVersion, 'v1.35.1');
    assert.deepEqual(
      result.workloads.map(({ component, pods, replicas }) => ({
        component,
        pods,
        replicas,
      })),
      [
        { component: 'web', pods: 2, replicas: 2 },
        { component: 'worker', pods: 1, replicas: 1 },
      ]
    );
    assert.equal(result.migration.digest, digest('migration'));
    assert.match(result.secretReferenceSha256, /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET, 'u'));
  });

  it('verifies the complete optional projector and connector-runner boundary', () => {
    const resources = snapshot({ optional: true });
    const result = verifyKubernetesRuntime(
      resources,
      options('analytics-projector,connector-runner')
    );
    assert.deepEqual(result.optionalComponents, [
      'analytics-projector',
      'connector-runner',
    ]);
    assert.deepEqual(
      result.workloads.map(({ component }) => component),
      ['web', 'worker', 'analytics-projector', 'connector-runner']
    );

    const exposedRunner = snapshot({ optional: true });
    const runnerPolicy = exposedRunner.items.find(
      (item) =>
        item.kind === 'NetworkPolicy' &&
        item.metadata.name === 'byok-grid-connector-runner'
    );
    runnerPolicy.spec.ingress[0].from[0].podSelector.matchLabels[
      'app.kubernetes.io/component'
    ] = 'web';
    assert.throws(
      () =>
        verifyKubernetesRuntime(
          exposedRunner,
          options('analytics-projector,connector-runner')
        ),
      /worker RPC/u
    );
  });

  it('rejects mutable or digest-mismatched pod execution', () => {
    const resources = snapshot();
    const webPod = component(resources, 'Pod', 'web');
    webPod.status.containerStatuses[0].imageID = `docker-pullable://ghcr.io/example/byok-grid-web@sha256:${'f'.repeat(64)}`;
    assert.throws(
      () => verifyKubernetesRuntime(resources, options()),
      /expected immutable image/u
    );

    const mutable = snapshot();
    component(
      mutable,
      'Deployment',
      'worker'
    ).spec.template.spec.containers[0].image =
      'ghcr.io/example/byok-grid-workflow-worker:latest';
    assert.throws(
      () => verifyKubernetesRuntime(mutable, options()),
      /release image digest/u
    );
  });

  it('rejects unstable, unready, or restarted workload pods', () => {
    const unstable = snapshot();
    component(unstable, 'Deployment', 'web').status.readyReplicas = 1;
    assert.throws(
      () => verifyKubernetesRuntime(unstable, options()),
      /stable ready Deployment/u
    );

    const restarted = snapshot();
    component(
      restarted,
      'Pod',
      'worker'
    ).status.containerStatuses[0].restartCount = 1;
    assert.throws(
      () => verifyKubernetesRuntime(restarted, options()),
      /immutable image cleanly/u
    );
  });

  it('rejects inline secrets and weakened pod isolation', () => {
    const inlineSecret = snapshot();
    const web = component(inlineSecret, 'Deployment', 'web');
    web.spec.template.spec.containers[0].env.find(
      ({ name }) => name === 'BYOK_GRID_MASTER_KEY'
    ).value = 'secret';
    assert.throws(
      () => verifyKubernetesRuntime(inlineSecret, options()),
      /sensitive configuration/u
    );

    const privileged = snapshot();
    component(
      privileged,
      'Deployment',
      'worker'
    ).spec.template.spec.containers[0].securityContext.privileged = true;
    assert.throws(
      () => verifyKubernetesRuntime(privileged, options()),
      /container security baseline/u
    );
  });

  it('rejects externally exposed Services and incomplete TLS ingress', () => {
    const publicService = snapshot();
    component(publicService, 'Service', 'web').spec.type = 'NodePort';
    assert.throws(
      () => verifyKubernetesRuntime(publicService, options()),
      /cluster-internal/u
    );

    const noTls = snapshot();
    resource(noTls, 'Ingress').spec.tls = [];
    assert.throws(
      () => verifyKubernetesRuntime(noTls, options()),
      /TLS Secret binding/u
    );
  });

  it('rejects missing isolation, world CIDRs, and missing migration or PDB proof', () => {
    const missingPolicy = snapshot();
    missingPolicy.items = missingPolicy.items.filter(
      (item) => item.metadata.name !== 'byok-grid-default-deny-ingress'
    );
    assert.throws(
      () => verifyKubernetesRuntime(missingPolicy, options()),
      /incomplete NetworkPolicy/u
    );

    const world = snapshot();
    const webEgress = world.items.find(
      (item) => item.metadata.name === 'byok-grid-web-egress'
    );
    webEgress.spec.egress[0].to = [{ ipBlock: { cidr: '0.0.0.0/0' } }];
    assert.throws(
      () => verifyKubernetesRuntime(world, options()),
      /world-routable/u
    );

    for (const kind of ['Job', 'PodDisruptionBudget']) {
      const missing = snapshot();
      missing.items = missing.items.filter((item) => item.kind !== kind);
      assert.throws(() => verifyKubernetesRuntime(missing, options()));
    }
  });

  it('keeps operator paths out of CLI failures and has no package imports', () => {
    const privatePath = '/operator/private-release-token/IMAGE_DIGESTS.txt';
    const result = spawnSync(
      process.execPath,
      ['scripts/verify-kubernetes-runtime.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...environment({
            BYOK_GRID_KUBERNETES_DIGEST_MANIFEST: privatePath,
          }),
          PATH: '/definitely-missing',
        },
      }
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /private-release-token/u);
    assert.match(result.stderr, /kubectl could not start/u);

    for (const path of [
      'scripts/verify-kubernetes-runtime-lib.mjs',
      'scripts/verify-kubernetes-runtime.mjs',
    ]) {
      const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(source, /from ['"](?!node:|\.)/u);
    }
  });
});

function environment(overrides = {}) {
  return {
    BYOK_GRID_KUBERNETES_VERIFY_CONFIRM: 'read-only-production-candidate',
    BYOK_GRID_KUBERNETES_CANDIDATE_SHA: CANDIDATE_COMMIT,
    BYOK_GRID_KUBERNETES_CONTEXT: 'production-cluster',
    BYOK_GRID_KUBERNETES_DIGEST_MANIFEST: '/operator/IMAGE_DIGESTS.txt',
    BYOK_GRID_KUBERNETES_NAMESPACE: NAMESPACE,
    BYOK_GRID_KUBERNETES_OPTIONAL_COMPONENTS: '',
    BYOK_GRID_KUBERNETES_APP_ORIGIN: 'https://grid.example.com',
    BYOK_GRID_KUBERNETES_RELEASE: RELEASE,
    ...overrides,
  };
}

function options(optionalComponents = '') {
  return {
    clusterVersion: 'v1.35.1',
    config: parseKubernetesVerificationEnvironment(
      environment({
        BYOK_GRID_KUBERNETES_OPTIONAL_COMPONENTS: optionalComponents,
      })
    ),
    manifest: MANIFEST,
    now: NOW,
  };
}

function snapshot({ optional = false } = {}) {
  const items = [
    deployment('web', 2, 'web'),
    deployment('worker', 1, 'workflow-worker'),
    pod('web', 'web-1', 'web', true),
    pod('web', 'web-2', 'web', true),
    pod('worker', 'worker-1', 'workflow-worker', true),
    migrationJob(),
    pod('migration', 'migrate-1', 'migration', false),
    service(),
    ingress(),
    disruptionBudget(),
    networkPolicy('default-deny-ingress', {
      podSelector: {
        matchLabels: {
          'app.kubernetes.io/name': 'byok-grid',
          'app.kubernetes.io/instance': RELEASE,
        },
      },
      policyTypes: ['Ingress'],
    }),
    networkPolicy('web-ingress', {
      podSelector: selector('web'),
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [{ namespaceSelector: { matchLabels: { ingress: 'true' } } }],
          ports: [{ protocol: 'TCP', port: 3000 }],
        },
      ],
    }),
    networkPolicy('worker-monitoring-ingress', {
      podSelector: selector('worker'),
      policyTypes: ['Ingress'],
      ingress: [
        {
          from: [
            { namespaceSelector: { matchLabels: { monitoring: 'true' } } },
          ],
          ports: [
            { protocol: 'TCP', port: 8081 },
            { protocol: 'TCP', port: 9464 },
          ],
        },
      ],
    }),
    networkPolicy('default-deny-runtime-egress', {
      podSelector: {
        matchExpressions: [
          {
            key: 'app.kubernetes.io/component',
            operator: 'In',
            values: ['web', 'worker'],
          },
        ],
      },
      policyTypes: ['Egress'],
    }),
    networkPolicy('web-egress', explicitEgress('web')),
    networkPolicy('worker-egress', explicitEgress('worker')),
  ];
  if (optional) {
    items.push(
      deployment('analytics-projector', 1, 'analytics-projector'),
      deployment('connector-runner', 1, 'connector-runner'),
      pod(
        'analytics-projector',
        'analytics-projector-1',
        'analytics-projector',
        true
      ),
      pod('connector-runner', 'connector-runner-1', 'connector-runner', true),
      connectorService(),
      networkPolicy(
        'analytics-projector-egress',
        explicitEgress('analytics-projector')
      ),
      networkPolicy('connector-runner', {
        podSelector: selector('connector-runner'),
        policyTypes: ['Ingress', 'Egress'],
        ingress: [
          {
            from: [{ podSelector: selector('worker') }],
            ports: [{ protocol: 'TCP', port: 4319 }],
          },
        ],
        egress: [],
      })
    );
    const defaultEgress = items.find(
      (item) => item.metadata.name === 'byok-grid-default-deny-runtime-egress'
    );
    defaultEgress.spec.podSelector.matchExpressions[0].values.push(
      'analytics-projector'
    );
  }
  return { apiVersion: 'v1', kind: 'List', items };
}

function deployment(componentName, replicas, target) {
  const image = MANIFEST.byTarget.get(target).image;
  return {
    apiVersion: 'apps/v1',
    kind: 'Deployment',
    metadata: metadata(componentName, `byok-grid-${componentName}`, 3),
    spec: {
      replicas,
      selector: selector(componentName),
      template: {
        metadata: { labels: labels(componentName) },
        spec: podSpec(componentName, target, image, true),
      },
    },
    status: {
      observedGeneration: 3,
      replicas,
      updatedReplicas: replicas,
      readyReplicas: replicas,
      availableReplicas: replicas,
      unavailableReplicas: 0,
    },
  };
}

function pod(componentName, name, target, running) {
  const image = MANIFEST.byTarget.get(target).image;
  const containerName =
    componentName === 'migration' ? 'migrate' : componentName;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: metadata(componentName, name),
    status: {
      phase: running ? 'Running' : 'Succeeded',
      conditions: running ? [{ type: 'Ready', status: 'True' }] : [],
      containerStatuses: [
        {
          name: containerName,
          image,
          imageID: `docker-pullable://${image}`,
          restartCount: 0,
          ready: running,
          state: running
            ? { running: { startedAt: '2026-08-04T15:00:00Z' } }
            : { terminated: { exitCode: 0 } },
        },
      ],
    },
  };
}

function migrationJob() {
  const image = MANIFEST.byTarget.get('migration').image;
  return {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      ...metadata('migration', 'byok-grid-migrate-1'),
      annotations: {
        'helm.sh/hook': 'pre-install,pre-upgrade',
        'helm.sh/hook-delete-policy': 'before-hook-creation',
      },
    },
    spec: {
      template: {
        metadata: { labels: labels('migration') },
        spec: podSpec('migration', 'migration', image, false),
      },
    },
    status: {
      succeeded: 1,
      failed: 0,
      completionTime: '2026-08-04T15:10:00Z',
      conditions: [{ type: 'Complete', status: 'True' }],
    },
  };
}

function podSpec(componentName, target, image, probes) {
  const containerName =
    componentName === 'migration' ? 'migrate' : componentName;
  const container = {
    name: containerName,
    image,
    securityContext: {
      allowPrivilegeEscalation: false,
      capabilities: { drop: ['ALL'] },
      readOnlyRootFilesystem: true,
    },
    env: environmentFor(componentName),
    resources: {
      requests: { cpu: '100m', memory: '128Mi' },
      limits: { memory: '512Mi' },
    },
  };
  if (probes) {
    container.livenessProbe = { httpGet: { path: '/live', port: 3000 } };
    container.readinessProbe = { httpGet: { path: '/ready', port: 3000 } };
    container.startupProbe = { httpGet: { path: '/live', port: 3000 } };
  }
  return {
    serviceAccountName: `byok-grid-${componentName}`,
    automountServiceAccountToken: false,
    securityContext: {
      runAsNonRoot: true,
      seccompProfile: { type: 'RuntimeDefault' },
    },
    containers: [container],
  };
}

function environmentFor(componentName) {
  const names =
    componentName === 'web'
      ? ['SQLITE_DATABASE_URL', 'BETTER_AUTH_SECRET', 'BYOK_GRID_MASTER_KEY']
      : componentName === 'worker'
        ? [
            'SQLITE_DATABASE_URL',
            'BYOK_GRID_MASTER_KEY',
            'HATCHET_CLIENT_TOKEN',
          ]
        : componentName === 'analytics-projector'
          ? ['SQLITE_DATABASE_URL', 'CLICKHOUSE_PASSWORD']
          : componentName === 'connector-runner'
            ? ['CONNECTOR_RUNNER_SHARED_SECRET']
            : ['SQLITE_DATABASE_URL'];
  return [
    ...(componentName === 'connector-runner'
      ? []
      : [{ name: 'BYOK_GRID_DATABASE_MODE', value: 'remote' }]),
    ...names.map((name) => ({
      name,
      valueFrom: {
        secretKeyRef: { name: SECRET, key: name.toLowerCase() },
      },
    })),
  ];
}

function service() {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: metadata('web', 'byok-grid-web'),
    spec: {
      type: 'ClusterIP',
      selector: selector('web').matchLabels,
      ports: [{ name: 'http', port: 80, targetPort: 3000 }],
    },
  };
}

function connectorService() {
  return {
    apiVersion: 'v1',
    kind: 'Service',
    metadata: metadata('connector-runner', 'byok-grid-connector-runner'),
    spec: {
      type: 'ClusterIP',
      selector: selector('connector-runner').matchLabels,
      ports: [{ name: 'grpc', port: 4319, targetPort: 4319 }],
    },
  };
}

function ingress() {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'Ingress',
    metadata: metadata(undefined, 'byok-grid'),
    spec: {
      ingressClassName: 'nginx',
      rules: [
        {
          host: 'grid.example.com',
          http: {
            paths: [
              {
                path: '/',
                pathType: 'Prefix',
                backend: {
                  service: { name: 'byok-grid-web', port: { number: 80 } },
                },
              },
            ],
          },
        },
      ],
      tls: [{ hosts: ['grid.example.com'], secretName: 'grid-tls' }],
    },
    status: { loadBalancer: { ingress: [{ hostname: 'edge.example.net' }] } },
  };
}

function disruptionBudget() {
  return {
    apiVersion: 'policy/v1',
    kind: 'PodDisruptionBudget',
    metadata: metadata('web', 'byok-grid-web', 2),
    spec: { minAvailable: 1, selector: selector('web') },
    status: { observedGeneration: 2, currentHealthy: 2, desiredHealthy: 1 },
  };
}

function networkPolicy(name, spec) {
  return {
    apiVersion: 'networking.k8s.io/v1',
    kind: 'NetworkPolicy',
    metadata: metadata(undefined, `byok-grid-${name}`),
    spec,
  };
}

function explicitEgress(componentName) {
  return {
    podSelector: selector(componentName),
    policyTypes: ['Egress'],
    egress: [
      {
        to: [{ namespaceSelector: { matchLabels: { data: 'true' } } }],
        ports: [{ protocol: 'TCP', port: 443 }],
      },
    ],
  };
}

function metadata(componentName, name, generation) {
  return {
    name,
    namespace: NAMESPACE,
    labels: labels(componentName),
    ...(generation === undefined ? {} : { generation }),
  };
}

function labels(componentName) {
  return {
    'app.kubernetes.io/name': 'byok-grid',
    'app.kubernetes.io/instance': RELEASE,
    'app.kubernetes.io/managed-by': 'Helm',
    ...(componentName === undefined
      ? {}
      : { 'app.kubernetes.io/component': componentName }),
  };
}

function selector(componentName) {
  return {
    matchLabels: {
      'app.kubernetes.io/name': 'byok-grid',
      'app.kubernetes.io/instance': RELEASE,
      'app.kubernetes.io/component': componentName,
    },
  };
}

function digest(target) {
  return MANIFEST.byTarget.get(target).digest;
}

function component(resources, kind, componentName) {
  return resources.items.find(
    (item) =>
      item.kind === kind &&
      item.metadata.labels['app.kubernetes.io/component'] === componentName
  );
}

function resource(resources, kind) {
  return resources.items.find((item) => item.kind === kind);
}
