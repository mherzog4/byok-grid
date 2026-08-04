import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { lstatSync, readFileSync } from 'node:fs';

export const KUBERNETES_NETWORK_POLICY_EVIDENCE_MARKER =
  'BYOK_GRID_KUBERNETES_NETWORK_POLICY_ENFORCEMENT_VERIFIED';

const CONFIRMATION = 'isolated-candidate-network-policy';
const ISOLATION_LABEL = 'byok-grid.dev/network-drill';
const ISOLATION_VALUE = 'isolated';
const RUN_LABEL = 'byok-grid.dev/network-drill-id';
const READINESS_GATE = 'byok-grid.dev/network-probe-ready';
const MAXIMUM_PLAN_BYTES = 131_072;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const LABEL_NAME_PATTERN = /^[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?$/u;
const LABEL_PREFIX_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const LABEL_VALUE_PATTERN =
  /^(?:[A-Za-z0-9](?:[-_.A-Za-z0-9]{0,61}[A-Za-z0-9])?)?$/u;
const OPTIONAL_COMPONENTS = Object.freeze([
  'analytics-projector',
  'connector-runner',
]);
const EXTERNAL_SOURCES = Object.freeze(['ingress', 'monitor', 'untrusted']);
const RELEASE_SOURCES = new Set([
  'analytics-projector',
  'connector-runner',
  'control',
  'migration',
  'web',
  'worker',
]);
const BASE_CLAIMS = Object.freeze({
  'control-unapproved-egress-allowed': {
    expectation: 'allowed',
    source: 'control',
  },
  'ingress-web-allowed': { expectation: 'allowed', source: 'ingress' },
  'ingress-worker-health-blocked': {
    expectation: 'blocked',
    source: 'ingress',
  },
  'migration-libsql-egress-allowed': {
    expectation: 'allowed',
    source: 'migration',
  },
  'migration-unapproved-egress-blocked': {
    expectation: 'blocked',
    source: 'migration',
  },
  'monitor-web-blocked': { expectation: 'blocked', source: 'monitor' },
  'monitor-worker-health-allowed': {
    expectation: 'allowed',
    source: 'monitor',
  },
  'monitor-worker-metrics-allowed': {
    expectation: 'allowed',
    source: 'monitor',
  },
  'untrusted-web-blocked': {
    expectation: 'blocked',
    source: 'untrusted',
  },
  'untrusted-worker-health-blocked': {
    expectation: 'blocked',
    source: 'untrusted',
  },
  'untrusted-worker-metrics-blocked': {
    expectation: 'blocked',
    source: 'untrusted',
  },
  'web-libsql-egress-allowed': {
    expectation: 'allowed',
    source: 'web',
  },
  'web-unapproved-egress-blocked': {
    expectation: 'blocked',
    source: 'web',
  },
  'worker-hatchet-egress-allowed': {
    expectation: 'allowed',
    source: 'worker',
  },
  'worker-libsql-egress-allowed': {
    expectation: 'allowed',
    source: 'worker',
  },
  'worker-unapproved-egress-blocked': {
    expectation: 'blocked',
    source: 'worker',
  },
});
const OPTIONAL_CLAIMS = Object.freeze({
  'analytics-projector': {
    'analytics-clickhouse-egress-allowed': {
      expectation: 'allowed',
      source: 'analytics-projector',
    },
    'analytics-unapproved-egress-blocked': {
      expectation: 'blocked',
      source: 'analytics-projector',
    },
  },
  'connector-runner': {
    'connector-unapproved-egress-blocked': {
      expectation: 'blocked',
      source: 'connector-runner',
    },
    'untrusted-runner-blocked': {
      expectation: 'blocked',
      source: 'untrusted',
    },
    'worker-runner-allowed': {
      expectation: 'allowed',
      source: 'worker',
    },
  },
});

const TCP_PROBE_SOURCE = String.raw`
const net = require('node:net');
const expected = process.env.EXPECTED_RESULT;
const timeoutMs = Number(process.env.CONNECT_TIMEOUT_MS);
let finished = false;
function finish(observed) {
  if (finished) return;
  finished = true;
  process.stdout.write(JSON.stringify({
    marker: 'BYOK_GRID_NETWORK_PROBE_RESULT',
    observed,
  }) + '\n');
  process.exitCode = observed === expected ? 0 : 1;
}
const socket = net.connect({
  host: process.env.TARGET_HOST,
  port: Number(process.env.TARGET_PORT),
});
socket.setTimeout(timeoutMs);
socket.once('connect', () => {
  socket.destroy();
  finish('allowed');
});
socket.once('error', () => finish('blocked'));
socket.once('timeout', () => {
  socket.destroy();
  finish('blocked');
});
`;

export class KubernetesNetworkPolicyDrillError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'KubernetesNetworkPolicyDrillError';
  }
}

export function parseNetworkPolicyDrillEnvironment(environment) {
  if (environment.BYOK_GRID_NETWORK_POLICY_DRILL_CONFIRM !== CONFIRMATION) {
    fail(
      `Set BYOK_GRID_NETWORK_POLICY_DRILL_CONFIRM=${CONFIRMATION} only for an isolated candidate environment.`
    );
  }
  const candidateCommit = required(
    environment,
    'BYOK_GRID_NETWORK_POLICY_CANDIDATE_SHA'
  );
  if (!SHA_PATTERN.test(candidateCommit)) {
    fail(
      'BYOK_GRID_NETWORK_POLICY_CANDIDATE_SHA must be a lowercase commit SHA.'
    );
  }
  const releaseNamespace = kubernetesName(
    environment,
    'BYOK_GRID_NETWORK_POLICY_RELEASE_NAMESPACE'
  );
  if (protectedNamespace(releaseNamespace)) {
    fail(
      'BYOK_GRID_NETWORK_POLICY_RELEASE_NAMESPACE must not be a protected Kubernetes namespace.'
    );
  }
  return {
    appName: kubernetesName(environment, 'BYOK_GRID_NETWORK_POLICY_APP_NAME'),
    candidateCommit,
    connectTimeoutMs: boundedInteger(
      environment.BYOK_GRID_NETWORK_POLICY_CONNECT_TIMEOUT_MS,
      'BYOK_GRID_NETWORK_POLICY_CONNECT_TIMEOUT_MS',
      5_000,
      1_000,
      20_000
    ),
    context: boundedText(environment, 'BYOK_GRID_NETWORK_POLICY_CONTEXT'),
    digestManifestPath: required(
      environment,
      'BYOK_GRID_NETWORK_POLICY_DIGEST_MANIFEST'
    ),
    optionalComponents: optionalList(
      environment.BYOK_GRID_NETWORK_POLICY_OPTIONAL_COMPONENTS
    ),
    planPath: required(environment, 'BYOK_GRID_NETWORK_POLICY_PLAN'),
    release: kubernetesName(environment, 'BYOK_GRID_NETWORK_POLICY_RELEASE'),
    releaseNamespace,
    totalTimeoutMs: boundedInteger(
      environment.BYOK_GRID_NETWORK_POLICY_TOTAL_TIMEOUT_MS,
      'BYOK_GRID_NETWORK_POLICY_TOTAL_TIMEOUT_MS',
      300_000,
      30_000,
      600_000
    ),
  };
}

export function readNetworkPolicyPlan(path, optionalComponents) {
  let source;
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size > MAXIMUM_PLAN_BYTES
    ) {
      fail('The NetworkPolicy drill plan must be a bounded regular file.');
    }
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof KubernetesNetworkPolicyDrillError) throw error;
    throw new KubernetesNetworkPolicyDrillError(
      'The NetworkPolicy drill plan could not be read.',
      { cause: error }
    );
  }
  return parseNetworkPolicyPlan(source, optionalComponents);
}

export function parseNetworkPolicyPlan(source, optionalComponents = []) {
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source) > MAXIMUM_PLAN_BYTES ||
    !source.endsWith('\n') ||
    source.includes('\r')
  ) {
    fail('The NetworkPolicy drill plan must be bounded canonical JSON text.');
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    fail('The NetworkPolicy drill plan must contain valid JSON.');
  }
  const root = exactObject(parsed, 'NetworkPolicy drill plan', [
    'namespaces',
    'probes',
    'schemaVersion',
    'targets',
  ]);
  if (root.schemaVersion !== 1) {
    fail('The NetworkPolicy drill plan schemaVersion must be 1.');
  }

  const namespaceRoot = exactObject(root.namespaces, 'plan namespaces', [
    ...EXTERNAL_SOURCES,
  ]);
  const namespaces = {};
  const namespaceNames = new Set();
  for (const sourceName of EXTERNAL_SOURCES) {
    const descriptor = exactObject(
      namespaceRoot[sourceName],
      `${sourceName} namespace`,
      ['name', 'namespaceLabels', 'podLabels']
    );
    const name = kubernetesNameValue(descriptor.name, 'probe namespace');
    if (protectedNamespace(name) || namespaceNames.has(name)) {
      fail('Probe namespaces must be distinct non-system namespaces.');
    }
    namespaceNames.add(name);
    const namespaceLabels = labelMap(
      descriptor.namespaceLabels,
      'namespace labels'
    );
    const podLabels = labelMap(descriptor.podLabels, 'probe pod labels', true);
    if (namespaceLabels[ISOLATION_LABEL] !== ISOLATION_VALUE) {
      fail('Every probe namespace must declare the isolation label.');
    }
    for (const reserved of [
      'app.kubernetes.io/component',
      'app.kubernetes.io/instance',
      'app.kubernetes.io/name',
      RUN_LABEL,
    ]) {
      if (podLabels[reserved] !== undefined) {
        fail('External probe labels must not impersonate release workloads.');
      }
    }
    namespaces[sourceName] = { name, namespaceLabels, podLabels };
  }

  const targets = array(root.targets, 'plan targets');
  if (targets.length === 0 || targets.length > 16) {
    fail('The NetworkPolicy drill plan has an invalid target count.');
  }
  const targetsById = new Map();
  let previousTargetId = '';
  for (const value of targets) {
    const target = exactObject(value, 'probe target', ['host', 'id', 'port']);
    const id = idValue(target.id, 'target id');
    if (id <= previousTargetId || targetsById.has(id)) {
      fail('Probe targets must be sorted and unique.');
    }
    previousTargetId = id;
    const host = targetHost(target.host);
    const port = portValue(target.port);
    targetsById.set(id, { host, id, port });
  }

  const expectedClaims = expectedClaimMap(optionalComponents);
  const probes = array(root.probes, 'plan probes');
  if (probes.length !== expectedClaims.size) {
    fail('The NetworkPolicy drill plan has an incomplete claim set.');
  }
  const normalizedProbes = [];
  let previousClaim = '';
  const claims = new Set();
  const referencedTargets = new Set();
  for (const value of probes) {
    const probe = exactObject(value, 'network probe', [
      'claim',
      'expectation',
      'source',
      'target',
    ]);
    const claim = idValue(probe.claim, 'probe claim');
    const expected = expectedClaims.get(claim);
    if (
      claim <= previousClaim ||
      claims.has(claim) ||
      !expected ||
      probe.source !== expected.source ||
      probe.expectation !== expected.expectation
    ) {
      fail('Network probes must exactly match the sorted claim contract.');
    }
    previousClaim = claim;
    claims.add(claim);
    const target = idValue(probe.target, 'probe target reference');
    if (!targetsById.has(target)) {
      fail('A network probe references an unknown target.');
    }
    referencedTargets.add(target);
    normalizedProbes.push({
      claim,
      expectation: expected.expectation,
      source: expected.source,
      target,
    });
  }
  if (
    referencedTargets.size !== targetsById.size ||
    [...targetsById.keys()].some((id) => !referencedTargets.has(id))
  ) {
    fail('Every declared probe target must be used.');
  }
  requireTargetBindings(normalizedProbes, optionalComponents);
  requireBlockedAvailabilityControls(normalizedProbes);

  return {
    namespaces,
    planSha256: sha256(source),
    probes: normalizedProbes,
    targetsById,
  };
}

export function inspectDrillNamespace(value, expectedName, expectedLabels) {
  const namespace = exactObject(value, 'Namespace response', [
    'apiVersion',
    'kind',
    'metadata',
    'spec',
    'status',
  ]);
  if (namespace.kind !== 'Namespace') {
    fail('kubectl returned the wrong namespace resource kind.');
  }
  const metadata = object(namespace.metadata, 'Namespace metadata');
  if (metadata.name !== expectedName) {
    fail('kubectl returned the wrong probe namespace.');
  }
  const actualLabels = object(metadata.labels, 'Namespace labels');
  if (
    actualLabels[ISOLATION_LABEL] !== ISOLATION_VALUE ||
    Object.entries(expectedLabels).some(
      ([key, value]) => actualLabels[key] !== value
    )
  ) {
    fail('A probe namespace does not have the declared isolation labels.');
  }
  return { name: expectedName };
}

export function createNetworkProbePod({
  appName,
  connectTimeoutMs,
  image,
  index,
  namespace,
  podLabels,
  probe,
  release,
  runId,
  target,
}) {
  if (!/^[-a-f0-9]{36}$/u.test(runId))
    fail('The network drill run ID is invalid.');
  const sourceLabels = sourceIdentityLabels(
    probe.source,
    appName,
    release,
    podLabels
  );
  const name = `byok-grid-netprobe-${runId.slice(0, 8)}-${String(index).padStart(2, '0')}`;
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      labels: {
        ...sourceLabels,
        [RUN_LABEL]: runId,
      },
      name,
      namespace,
    },
    spec: {
      activeDeadlineSeconds: Math.ceil(connectTimeoutMs / 1_000) + 30,
      automountServiceAccountToken: false,
      containers: [
        {
          args: ['--eval', TCP_PROBE_SOURCE],
          command: ['node'],
          env: [
            { name: 'CONNECT_TIMEOUT_MS', value: String(connectTimeoutMs) },
            { name: 'EXPECTED_RESULT', value: probe.expectation },
            { name: 'TARGET_HOST', value: target.host },
            { name: 'TARGET_PORT', value: String(target.port) },
          ],
          image,
          imagePullPolicy: 'IfNotPresent',
          name: 'probe',
          resources: {
            limits: { memory: '64Mi' },
            requests: { cpu: '10m', memory: '32Mi' },
          },
          securityContext: {
            allowPrivilegeEscalation: false,
            capabilities: { drop: ['ALL'] },
            privileged: false,
            readOnlyRootFilesystem: true,
          },
        },
      ],
      dnsPolicy: 'ClusterFirst',
      enableServiceLinks: false,
      readinessGates: [{ conditionType: READINESS_GATE }],
      restartPolicy: 'Never',
      securityContext: {
        runAsGroup: 1000,
        runAsNonRoot: true,
        runAsUser: 1000,
        seccompProfile: { type: 'RuntimeDefault' },
      },
      terminationGracePeriodSeconds: 1,
    },
  };
}

export function inspectCreatedProbePod(value, expected) {
  const pod = object(value, 'created Pod');
  const container = pod.spec?.containers?.[0];
  const expectedContainer = expected.spec.containers[0];
  if (
    pod.kind !== 'Pod' ||
    pod.metadata?.name !== expected.metadata.name ||
    pod.metadata?.namespace !== expected.metadata.namespace ||
    !sameRecord(pod.metadata?.labels, expected.metadata.labels) ||
    pod.spec?.automountServiceAccountToken !== false ||
    pod.spec?.activeDeadlineSeconds !== expected.spec.activeDeadlineSeconds ||
    pod.spec?.dnsPolicy !== expected.spec.dnsPolicy ||
    pod.spec?.enableServiceLinks !== false ||
    pod.spec?.restartPolicy !== 'Never' ||
    pod.spec?.terminationGracePeriodSeconds !== 1 ||
    pod.spec?.readinessGates?.length !== 1 ||
    pod.spec?.readinessGates?.[0]?.conditionType !== READINESS_GATE ||
    pod.spec?.securityContext?.runAsNonRoot !== true ||
    pod.spec?.securityContext?.runAsGroup !== 1000 ||
    pod.spec?.securityContext?.runAsUser !== 1000 ||
    pod.spec?.securityContext?.seccompProfile?.type !== 'RuntimeDefault' ||
    pod.spec?.containers?.length !== 1 ||
    container?.image !== expectedContainer.image ||
    container?.imagePullPolicy !== expectedContainer.imagePullPolicy ||
    !sameArray(container?.command, expectedContainer.command) ||
    !sameArray(container?.args, expectedContainer.args) ||
    JSON.stringify(container?.env) !== JSON.stringify(expectedContainer.env) ||
    container?.securityContext?.allowPrivilegeEscalation !== false ||
    container?.securityContext?.privileged !== false ||
    container?.securityContext?.readOnlyRootFilesystem !== true ||
    !sameArray(container?.securityContext?.capabilities?.drop, ['ALL'])
  ) {
    fail('kubectl did not create the exact bounded network probe Pod.');
  }
  return { name: expected.name, namespace: expected.namespace };
}

export function inspectCompletedProbePod(value) {
  const pod = object(value, 'completed Pod');
  const statuses = array(
    pod.status?.containerStatuses,
    'probe container statuses'
  );
  const matches = statuses.filter((status) => status?.name === 'probe');
  if (
    pod.kind !== 'Pod' ||
    pod.status?.phase !== 'Succeeded' ||
    matches.length !== 1 ||
    matches[0].restartCount !== 0 ||
    matches[0].state?.terminated?.exitCode !== 0 ||
    conditionTrue(pod.status?.conditions, 'Ready')
  ) {
    fail(
      'A network probe Pod did not complete cleanly while remaining NotReady.'
    );
  }
  return { completed: true };
}

export function parseNetworkProbeLog(source, expectation) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 4_096) {
    fail('A network probe emitted malformed bounded output.');
  }
  const lines = source.trim().split('\n');
  if (lines.length !== 1) {
    fail('A network probe emitted an unexpected output shape.');
  }
  let record;
  try {
    record = JSON.parse(lines[0]);
  } catch {
    fail('A network probe emitted malformed JSON.');
  }
  const exact = exactObject(record, 'network probe result', [
    'marker',
    'observed',
  ]);
  if (
    exact.marker !== 'BYOK_GRID_NETWORK_PROBE_RESULT' ||
    exact.observed !== expectation
  ) {
    fail('A network probe did not observe its declared policy outcome.');
  }
  return { observed: expectation };
}

export function buildNetworkPolicyEvidence({
  config,
  manifest,
  now = new Date(),
  plan,
  results,
  runId = randomUUID(),
}) {
  const verifiedAt = dateOption(now, 'verification clock').toISOString();
  const claims = results.map((result) => result.claim).sort();
  const expectedClaims = [
    ...expectedClaimMap(config.optionalComponents).keys(),
  ];
  if (!sameArray(claims, expectedClaims)) {
    fail('The completed probe results do not cover the exact claim contract.');
  }
  if (
    results.some(
      (result) =>
        !result ||
        result.observed !== result.expectation ||
        !claims.includes(result.claim)
    )
  ) {
    fail('A completed probe result does not match its expected outcome.');
  }
  const maintenance = manifest.byTarget.get('maintenance');
  if (!maintenance) fail('The release manifest has no maintenance image.');
  return {
    candidateCommit: config.candidateCommit,
    claims,
    context: config.context,
    digestManifestSha256: manifest.sha256,
    maintenanceDigest: maintenance.digest,
    marker: KUBERNETES_NETWORK_POLICY_EVIDENCE_MARKER,
    optionalComponents: config.optionalComponents,
    planSha256: plan.planSha256,
    probeCount: results.length,
    release: config.release,
    releaseNamespace: config.releaseNamespace,
    runId,
    targetSetSha256: sha256(
      JSON.stringify(
        [...plan.targetsById.values()].map(({ host, id, port }) => ({
          host,
          id,
          port,
        }))
      )
    ),
    verifiedAt,
  };
}

export function probeExecutionOrder(probes) {
  return [...probes].sort(
    (left, right) =>
      left.target.localeCompare(right.target) ||
      Number(left.expectation === 'blocked') -
        Number(right.expectation === 'blocked') ||
      left.claim.localeCompare(right.claim)
  );
}

export function sourceNamespace(probe, plan, releaseNamespace) {
  return EXTERNAL_SOURCES.includes(probe.source)
    ? plan.namespaces[probe.source].name
    : releaseNamespace;
}

export function sourcePodLabels(probe, plan) {
  return EXTERNAL_SOURCES.includes(probe.source)
    ? plan.namespaces[probe.source].podLabels
    : {};
}

export function networkPolicyDrillRunId() {
  return randomUUID();
}

function expectedClaimMap(optionalComponents) {
  const claims = { ...BASE_CLAIMS };
  for (const component of optionalComponents) {
    Object.assign(claims, OPTIONAL_CLAIMS[component]);
  }
  return new Map(
    Object.entries(claims).sort(([left], [right]) => left.localeCompare(right))
  );
}

function requireTargetBindings(probes, optionalComponents) {
  const groups = [
    ['ingress-web-allowed', 'monitor-web-blocked', 'untrusted-web-blocked'],
    [
      'ingress-worker-health-blocked',
      'monitor-worker-health-allowed',
      'untrusted-worker-health-blocked',
    ],
    ['monitor-worker-metrics-allowed', 'untrusted-worker-metrics-blocked'],
    [
      'migration-libsql-egress-allowed',
      'web-libsql-egress-allowed',
      'worker-libsql-egress-allowed',
    ],
    [
      'control-unapproved-egress-allowed',
      'migration-unapproved-egress-blocked',
      'web-unapproved-egress-blocked',
      'worker-unapproved-egress-blocked',
      ...(optionalComponents.includes('analytics-projector')
        ? ['analytics-unapproved-egress-blocked']
        : []),
      ...(optionalComponents.includes('connector-runner')
        ? ['connector-unapproved-egress-blocked']
        : []),
    ],
  ];
  if (optionalComponents.includes('connector-runner')) {
    groups.push(['untrusted-runner-blocked', 'worker-runner-allowed']);
  }
  const byClaim = new Map(probes.map((probe) => [probe.claim, probe]));
  for (const claims of groups) {
    const targetIds = new Set(
      claims.map((claim) => byClaim.get(claim)?.target)
    );
    if (targetIds.size !== 1 || targetIds.has(undefined)) {
      fail('Related NetworkPolicy claims must probe the same destination.');
    }
  }
}

function requireBlockedAvailabilityControls(probes) {
  const allowedTargets = new Set(
    probes
      .filter((probe) => probe.expectation === 'allowed')
      .map((probe) => probe.target)
  );
  if (
    probes.some(
      (probe) =>
        probe.expectation === 'blocked' && !allowedTargets.has(probe.target)
    )
  ) {
    fail(
      'Every blocked probe needs a successful same-target availability control.'
    );
  }
}

function sourceIdentityLabels(source, appName, release, podLabels) {
  if (EXTERNAL_SOURCES.includes(source)) return { ...podLabels };
  if (!RELEASE_SOURCES.has(source))
    fail('The network probe source is invalid.');
  if (source === 'control') return {};
  return {
    'app.kubernetes.io/component': source,
    'app.kubernetes.io/instance': release,
    'app.kubernetes.io/name': appName,
  };
}

function optionalList(value) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) {
    fail('BYOK_GRID_NETWORK_POLICY_OPTIONAL_COMPONENTS is invalid.');
  }
  const values = value.split(',');
  if (
    new Set(values).size !== values.length ||
    !sameArray([...values].sort(), values) ||
    values.some((item) => !OPTIONAL_COMPONENTS.includes(item))
  ) {
    fail(
      'BYOK_GRID_NETWORK_POLICY_OPTIONAL_COMPONENTS must be a sorted unique supported list.'
    );
  }
  return values;
}

function labelMap(value, name, allowEmpty = false) {
  const labels = exactRecord(value, name);
  const entries = Object.entries(labels);
  if ((!allowEmpty && entries.length === 0) || entries.length > 16) {
    fail(`The ${name} have an invalid entry count.`);
  }
  for (const [key, labelValue] of entries) {
    labelKey(key);
    if (
      typeof labelValue !== 'string' ||
      !LABEL_VALUE_PATTERN.test(labelValue)
    ) {
      fail(`The ${name} contain an invalid value.`);
    }
  }
  return labels;
}

function labelKey(value) {
  if (typeof value !== 'string') fail('A Kubernetes label key is invalid.');
  const pieces = value.split('/');
  if (
    pieces.length > 2 ||
    !LABEL_NAME_PATTERN.test(pieces.at(-1)) ||
    (pieces.length === 2 && !LABEL_PREFIX_PATTERN.test(pieces[0]))
  ) {
    fail('A Kubernetes label key is invalid.');
  }
  return value;
}

function targetHost(value) {
  if (
    typeof value !== 'string' ||
    /[\0\r\n]/u.test(value) ||
    (!isIP(value) && !HOST_PATTERN.test(value))
  ) {
    fail('A probe target host is invalid.');
  }
  return value;
}

function portValue(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    fail('A probe target port is invalid.');
  }
  return value;
}

function boundedInteger(value, name, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/u.test(value)) fail(`${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} is outside the supported range.`);
  }
  return parsed;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0)
    fail(`${name} is required.`);
  if (/[\0\r\n]/u.test(value)) fail(`${name} contains control characters.`);
  return value;
}

function boundedText(environment, name) {
  const value = required(environment, name);
  if (value.length > 253) fail(`${name} is too long.`);
  return value;
}

function kubernetesName(environment, name) {
  return kubernetesNameValue(boundedText(environment, name), name);
}

function kubernetesNameValue(value, name) {
  if (typeof value !== 'string' || !DNS_LABEL_PATTERN.test(value)) {
    fail(`${name} must be a lowercase Kubernetes DNS label.`);
  }
  return value;
}

function idValue(value, name) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    fail(`The ${name} is invalid.`);
  }
  return value;
}

function protectedNamespace(value) {
  return ['default', 'kube-node-lease', 'kube-public', 'kube-system'].includes(
    value
  );
}

function conditionTrue(conditions, type) {
  return (
    Array.isArray(conditions) &&
    conditions.some(
      (condition) => condition?.type === type && condition.status === 'True'
    )
  );
}

function exactObject(value, name, expectedKeys) {
  const result = object(value, name);
  const keys = Object.keys(result).sort();
  const expected = [...expectedKeys].sort();
  if (!sameArray(keys, expected)) {
    fail(`The ${name} has missing or unexpected fields.`);
  }
  return result;
}

function exactRecord(value, name) {
  const result = object(value, name);
  if (Object.getPrototypeOf(result) !== Object.prototype) {
    fail(`The ${name} response is malformed.`);
  }
  return result;
}

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`The ${name} response is malformed.`);
  }
  return value;
}

function array(value, name) {
  if (!Array.isArray(value)) fail(`The ${name} response is malformed.`);
  return value;
}

function dateOption(value, name) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(`The ${name} is invalid.`);
  }
  return value;
}

function sameArray(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameRecord(left, right) {
  if (
    !left ||
    !right ||
    typeof left !== 'object' ||
    typeof right !== 'object'
  ) {
    return false;
  }
  const leftEntries = Object.entries(left).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  const rightEntries = Object.entries(right).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new KubernetesNetworkPolicyDrillError(message);
}
