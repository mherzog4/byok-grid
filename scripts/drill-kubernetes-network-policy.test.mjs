import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  KUBERNETES_NETWORK_POLICY_EVIDENCE_MARKER,
  buildNetworkPolicyEvidence,
  createNetworkProbePod,
  inspectCompletedProbePod,
  inspectCreatedProbePod,
  inspectDrillNamespace,
  parseNetworkPolicyDrillEnvironment,
  parseNetworkPolicyPlan,
  parseNetworkProbeLog,
  probeExecutionOrder,
  readNetworkPolicyPlan,
  sourceNamespace,
  sourcePodLabels,
} from './drill-kubernetes-network-policy-lib.mjs';
import { parseReleaseDigestManifest } from './verify-kubernetes-runtime-lib.mjs';

const CANDIDATE_COMMIT = 'a'.repeat(40);
const RUN_ID = '12345678-1234-4234-8234-123456789abc';
const NOW = new Date('2026-08-04T18:00:00.000Z');
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

describe('Kubernetes NetworkPolicy enforcement drill', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'byok-grid-network-policy-'));
  });

  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  it('requires explicit isolated-candidate configuration', () => {
    assert.deepEqual(parseNetworkPolicyDrillEnvironment(environment()), {
      appName: 'byok-grid',
      candidateCommit: CANDIDATE_COMMIT,
      connectTimeoutMs: 5_000,
      context: 'candidate-cluster',
      digestManifestPath: '/operator/IMAGE_DIGESTS.txt',
      optionalComponents: [],
      planPath: '/operator/network-policy-plan.json',
      release: 'byok-grid',
      releaseNamespace: 'byok-grid-drill',
      totalTimeoutMs: 300_000,
    });
    for (const mutation of [
      { BYOK_GRID_NETWORK_POLICY_DRILL_CONFIRM: 'yes' },
      { BYOK_GRID_NETWORK_POLICY_CANDIDATE_SHA: 'A'.repeat(40) },
      { BYOK_GRID_NETWORK_POLICY_RELEASE_NAMESPACE: 'default' },
      { BYOK_GRID_NETWORK_POLICY_CONNECT_TIMEOUT_MS: '999' },
      {
        BYOK_GRID_NETWORK_POLICY_OPTIONAL_COMPONENTS:
          'connector-runner,analytics-projector',
      },
    ]) {
      assert.throws(() =>
        parseNetworkPolicyDrillEnvironment({ ...environment(), ...mutation })
      );
    }
  });

  it('accepts the exact base claim set with same-target availability controls', () => {
    const source = planSource();
    const parsed = parseNetworkPolicyPlan(source);
    assert.equal(parsed.probes.length, 16);
    assert.equal(parsed.targetsById.size, 6);
    assert.match(parsed.planSha256, /^[0-9a-f]{64}$/u);
    const web = parsed.probes.filter(({ target }) => target === 'web');
    assert.deepEqual(
      web.map(({ claim, expectation }) => ({ claim, expectation })),
      [
        { claim: 'ingress-web-allowed', expectation: 'allowed' },
        { claim: 'monitor-web-blocked', expectation: 'blocked' },
        { claim: 'untrusted-web-blocked', expectation: 'blocked' },
      ]
    );
    const execution = probeExecutionOrder(parsed.probes);
    for (const target of new Set(execution.map((probe) => probe.target))) {
      const values = execution.filter((probe) => probe.target === target);
      const firstBlocked = values.findIndex(
        (probe) => probe.expectation === 'blocked'
      );
      if (firstBlocked >= 0) {
        assert.equal(
          values
            .slice(0, firstBlocked)
            .every((probe) => probe.expectation === 'allowed'),
          true
        );
      }
    }
  });

  it('requires optional projector and runner claims only when declared', () => {
    const optional = ['analytics-projector', 'connector-runner'];
    const parsed = parseNetworkPolicyPlan(planSource({ optional }), optional);
    assert.equal(parsed.probes.length, 21);
    assert.equal(parsed.targetsById.size, 8);
    assert.equal(
      parsed.probes.some(
        ({ claim }) => claim === 'analytics-clickhouse-egress-allowed'
      ),
      true
    );
    assert.equal(
      parsed.probes.some(({ claim }) => claim === 'worker-runner-allowed'),
      true
    );
    assert.throws(() => parseNetworkPolicyPlan(planSource({ optional })));
  });

  it('rejects incomplete, impersonating, unpaired, or drifted plans', () => {
    const mutations = [
      (plan) => plan.probes.pop(),
      (plan) => {
        plan.probes.find(
          ({ claim }) => claim === 'untrusted-web-blocked'
        ).source = 'ingress';
      },
      (plan) => {
        plan.probes.find(
          ({ claim }) => claim === 'monitor-web-blocked'
        ).target = 'worker-health';
      },
      (plan) => {
        plan.probes.find(
          ({ claim }) => claim === 'ingress-web-allowed'
        ).expectation = 'blocked';
      },
      (plan) => {
        plan.namespaces.untrusted.podLabels['app.kubernetes.io/component'] =
          'worker';
      },
      (plan) => {
        plan.namespaces.ingress.namespaceLabels['byok-grid.dev/network-drill'] =
          'production';
      },
      (plan) => {
        plan.targets.push({
          host: 'unused.example.net',
          id: 'zz-unused',
          port: 443,
        });
      },
      (plan) => {
        plan.debug = true;
      },
    ];
    for (const mutate of mutations) {
      const plan = planValue();
      mutate(plan);
      assert.throws(() => parseNetworkPolicyPlan(json(plan)));
    }
  });

  it('reads only a bounded regular plan without exposing its path', () => {
    const path = join(directory, 'plan.json');
    const link = join(directory, 'private-network-endpoints');
    writeFileSync(path, planSource());
    symlinkSync(path, link);
    assert.equal(readNetworkPolicyPlan(path, []).probes.length, 16);
    assert.throws(
      () => readNetworkPolicyPlan(link, []),
      (error) => {
        assert.doesNotMatch(String(error), /private-network-endpoints/u);
        return true;
      }
    );
  });

  it('requires every namespace to carry the declared isolation labels', () => {
    const namespace = namespaceFixture('probe-ingress', {
      'byok-grid.dev/network-drill': 'isolated',
      'network-role': 'ingress',
    });
    assert.deepEqual(
      inspectDrillNamespace(namespace, 'probe-ingress', {
        'byok-grid.dev/network-drill': 'isolated',
        'network-role': 'ingress',
      }),
      { name: 'probe-ingress' }
    );
    namespace.metadata.labels['byok-grid.dev/network-drill'] = 'production';
    assert.throws(() =>
      inspectDrillNamespace(namespace, 'probe-ingress', {
        'byok-grid.dev/network-drill': 'isolated',
      })
    );
  });

  it('builds an immutable token-free NotReady probe with exact source identity', () => {
    const plan = parseNetworkPolicyPlan(planSource());
    const probe = plan.probes.find(
      ({ claim }) => claim === 'worker-libsql-egress-allowed'
    );
    const pod = probePod(probe, plan, 1);
    assert.equal(pod.metadata.namespace, 'byok-grid-drill');
    assert.equal(pod.metadata.labels['app.kubernetes.io/component'], 'worker');
    assert.equal(pod.spec.automountServiceAccountToken, false);
    assert.equal(
      pod.spec.readinessGates[0].conditionType,
      'byok-grid.dev/network-probe-ready'
    );
    assert.equal(pod.spec.securityContext.runAsNonRoot, true);
    assert.equal(
      pod.spec.containers[0].image,
      MANIFEST.byTarget.get('maintenance').image
    );
    assert.equal(
      pod.spec.containers[0].securityContext.readOnlyRootFilesystem,
      true
    );
    assert.deepEqual(pod.spec.containers[0].securityContext.capabilities.drop, [
      'ALL',
    ]);
    assert.doesNotThrow(() => inspectCreatedProbePod(pod, pod));
    const mutated = structuredClone(pod);
    mutated.metadata.labels['app.kubernetes.io/component'] = 'web';
    assert.throws(() => inspectCreatedProbePod(mutated, pod));
    mutated.metadata.labels['app.kubernetes.io/component'] = 'worker';
    mutated.spec.containers[0].env.find(
      ({ name }) => name === 'TARGET_PORT'
    ).value = '1';
    assert.throws(() => inspectCreatedProbePod(mutated, pod));

    const untrusted = plan.probes.find(
      ({ claim }) => claim === 'untrusted-web-blocked'
    );
    const untrustedPod = probePod(untrusted, plan, 2);
    assert.equal(
      untrustedPod.metadata.labels['app.kubernetes.io/component'],
      undefined
    );
    assert.deepEqual(sourcePodLabels(untrusted, plan), {});
    assert.equal(
      sourceNamespace(untrusted, plan, 'byok-grid-drill'),
      'probe-untrusted'
    );
  });

  it('accepts only clean NotReady completion and one exact result record', () => {
    const completed = completedPodFixture();
    assert.deepEqual(inspectCompletedProbePod(completed), { completed: true });
    assert.deepEqual(
      parseNetworkProbeLog(
        '{"marker":"BYOK_GRID_NETWORK_PROBE_RESULT","observed":"blocked"}',
        'blocked'
      ),
      { observed: 'blocked' }
    );
    completed.status.conditions[0].status = 'True';
    assert.throws(() => inspectCompletedProbePod(completed), /NotReady/u);
    assert.throws(() =>
      parseNetworkProbeLog(
        '{"marker":"BYOK_GRID_NETWORK_PROBE_RESULT","observed":"allowed"}',
        'blocked'
      )
    );
  });

  it('emits candidate-bound sanitized evidence for the exact results', () => {
    const plan = parseNetworkPolicyPlan(planSource());
    const results = plan.probes.map((probe) => ({
      ...probe,
      observed: probe.expectation,
    }));
    const evidence = buildNetworkPolicyEvidence({
      config: parseNetworkPolicyDrillEnvironment(environment()),
      manifest: MANIFEST,
      now: NOW,
      plan,
      results,
      runId: RUN_ID,
    });
    assert.equal(evidence.marker, KUBERNETES_NETWORK_POLICY_EVIDENCE_MARKER);
    assert.equal(evidence.candidateCommit, CANDIDATE_COMMIT);
    assert.equal(evidence.probeCount, 16);
    assert.equal(
      evidence.maintenanceDigest,
      MANIFEST.byTarget.get('maintenance').digest
    );
    assert.match(evidence.targetSetSha256, /^[0-9a-f]{64}$/u);
    assert.doesNotMatch(
      JSON.stringify(evidence),
      /cluster\.local|example\.net/u
    );
  });

  it('orchestrates create, observe, and exact cleanup without leaking targets', () => {
    const bin = join(directory, 'bin');
    const state = join(directory, 'state');
    const planPath = join(directory, 'network-policy-plan.json');
    const digestPath = join(directory, 'IMAGE_DIGESTS.txt');
    const kubectlPath = join(bin, 'kubectl');
    writeFileSync(planPath, planSource());
    writeFileSync(digestPath, DIGEST_SOURCE);
    writeExecutable(
      kubectlPath,
      `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const state = process.env.FAKE_NETWORK_STATE;
fs.mkdirSync(state, { recursive: true });
function valueAfter(name) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
function namespaceLabels(name) {
  const labels = { 'byok-grid.dev/network-drill': 'isolated' };
  if (name === 'probe-ingress') labels['network-role'] = 'ingress';
  if (name === 'probe-monitor') labels['network-role'] = 'monitor';
  if (name === 'probe-untrusted') labels['network-role'] = 'untrusted';
  return labels;
}
if (args.includes('config') && args.includes('current-context')) {
  process.stdout.write('candidate-cluster\\n');
} else if (args.includes('get') && args.includes('namespace')) {
  const name = args[args.indexOf('namespace') + 1];
  process.stdout.write(JSON.stringify({ apiVersion: 'v1', kind: 'Namespace', metadata: { name, labels: namespaceLabels(name) }, spec: {}, status: { phase: 'Active' } }));
} else if (args.includes('create')) {
  const pod = JSON.parse(fs.readFileSync(0, 'utf8'));
  fs.writeFileSync(path.join(state, pod.metadata.name + '.json'), JSON.stringify(pod));
  process.stdout.write(JSON.stringify(pod));
} else if (args.includes('get') && args.includes('pod')) {
  const name = args[args.indexOf('pod') + 1];
  const pod = JSON.parse(fs.readFileSync(path.join(state, name + '.json'), 'utf8'));
  pod.status = { phase: 'Succeeded', conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ name: 'probe', restartCount: 0, state: { terminated: { exitCode: 0 } } }] };
  process.stdout.write(JSON.stringify(pod));
} else if (args.includes('logs')) {
  const name = args[args.indexOf('logs') + 1];
  const pod = JSON.parse(fs.readFileSync(path.join(state, name + '.json'), 'utf8'));
  const expected = pod.spec.containers[0].env.find(entry => entry.name === 'EXPECTED_RESULT').value;
  process.stdout.write(JSON.stringify({ marker: 'BYOK_GRID_NETWORK_PROBE_RESULT', observed: expected }) + '\\n');
} else if (args.includes('delete') && args.includes('pod')) {
  const name = args[args.indexOf('pod') + 1];
  fs.rmSync(path.join(state, name + '.json'), { force: true });
  process.stdout.write('pod deleted\\n');
} else {
  process.exitCode = 1;
}
`
    );
    const result = spawnSync(
      process.execPath,
      ['scripts/drill-kubernetes-network-policy.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...environment({
            BYOK_GRID_NETWORK_POLICY_DIGEST_MANIFEST: digestPath,
            BYOK_GRID_NETWORK_POLICY_PLAN: planPath,
          }),
          FAKE_NETWORK_STATE: state,
          PATH: `${bin}:${process.env.PATH ?? ''}`,
        },
        timeout: 15_000,
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.marker, KUBERNETES_NETWORK_POLICY_EVIDENCE_MARKER);
    assert.equal(evidence.probeCount, 16);
    assert.deepEqual(readdirSync(state), []);
    assert.doesNotMatch(result.stdout, /cluster\.local|sentinel\.example/u);
  });

  it('keeps plan paths out of CLI failures and runtime imports dependency-free', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/drill-kubernetes-network-policy.mjs'],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...environment({
            BYOK_GRID_NETWORK_POLICY_PLAN:
              '/operator/private-endpoint-token/plan.json',
          }),
          PATH: '/definitely-missing',
        },
      }
    );
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /private-endpoint-token/u);
    for (const path of [
      'scripts/drill-kubernetes-network-policy-lib.mjs',
      'scripts/drill-kubernetes-network-policy.mjs',
    ]) {
      assert.doesNotMatch(readFileSync(path, 'utf8'), /from ['"](?!node:|\.)/u);
    }
  });
});

function environment(overrides = {}) {
  return {
    BYOK_GRID_NETWORK_POLICY_DRILL_CONFIRM: 'isolated-candidate-network-policy',
    BYOK_GRID_NETWORK_POLICY_APP_NAME: 'byok-grid',
    BYOK_GRID_NETWORK_POLICY_CANDIDATE_SHA: CANDIDATE_COMMIT,
    BYOK_GRID_NETWORK_POLICY_CONTEXT: 'candidate-cluster',
    BYOK_GRID_NETWORK_POLICY_DIGEST_MANIFEST: '/operator/IMAGE_DIGESTS.txt',
    BYOK_GRID_NETWORK_POLICY_OPTIONAL_COMPONENTS: '',
    BYOK_GRID_NETWORK_POLICY_PLAN: '/operator/network-policy-plan.json',
    BYOK_GRID_NETWORK_POLICY_RELEASE: 'byok-grid',
    BYOK_GRID_NETWORK_POLICY_RELEASE_NAMESPACE: 'byok-grid-drill',
    ...overrides,
  };
}

function planSource({ optional = [] } = {}) {
  return json(planValue({ optional }));
}

function planValue({ optional = [] } = {}) {
  const claims = {
    'control-unapproved-egress-allowed': ['control', 'allowed', 'unapproved'],
    'ingress-web-allowed': ['ingress', 'allowed', 'web'],
    'ingress-worker-health-blocked': ['ingress', 'blocked', 'worker-health'],
    'migration-libsql-egress-allowed': ['migration', 'allowed', 'libsql'],
    'migration-unapproved-egress-blocked': [
      'migration',
      'blocked',
      'unapproved',
    ],
    'monitor-web-blocked': ['monitor', 'blocked', 'web'],
    'monitor-worker-health-allowed': ['monitor', 'allowed', 'worker-health'],
    'monitor-worker-metrics-allowed': ['monitor', 'allowed', 'worker-metrics'],
    'untrusted-web-blocked': ['untrusted', 'blocked', 'web'],
    'untrusted-worker-health-blocked': [
      'untrusted',
      'blocked',
      'worker-health',
    ],
    'untrusted-worker-metrics-blocked': [
      'untrusted',
      'blocked',
      'worker-metrics',
    ],
    'web-libsql-egress-allowed': ['web', 'allowed', 'libsql'],
    'web-unapproved-egress-blocked': ['web', 'blocked', 'unapproved'],
    'worker-hatchet-egress-allowed': ['worker', 'allowed', 'hatchet'],
    'worker-libsql-egress-allowed': ['worker', 'allowed', 'libsql'],
    'worker-unapproved-egress-blocked': ['worker', 'blocked', 'unapproved'],
  };
  const targets = {
    hatchet: ['hatchet.internal.example.net', 443],
    libsql: ['libsql.internal.example.net', 443],
    unapproved: ['sentinel.example.net', 443],
    web: ['byok-grid-web.byok-grid-drill.svc.cluster.local', 80],
    'worker-health': [
      'byok-grid-worker.byok-grid-drill.pod.cluster.local',
      8001,
    ],
    'worker-metrics': [
      'byok-grid-worker.byok-grid-drill.pod.cluster.local',
      8002,
    ],
  };
  if (optional.includes('analytics-projector')) {
    claims['analytics-clickhouse-egress-allowed'] = [
      'analytics-projector',
      'allowed',
      'clickhouse',
    ];
    claims['analytics-unapproved-egress-blocked'] = [
      'analytics-projector',
      'blocked',
      'unapproved',
    ];
    targets.clickhouse = ['clickhouse.internal.example.net', 8443];
  }
  if (optional.includes('connector-runner')) {
    claims['connector-unapproved-egress-blocked'] = [
      'connector-runner',
      'blocked',
      'unapproved',
    ];
    claims['untrusted-runner-blocked'] = ['untrusted', 'blocked', 'runner'];
    claims['worker-runner-allowed'] = ['worker', 'allowed', 'runner'];
    targets.runner = [
      'byok-grid-runner.byok-grid-drill.svc.cluster.local',
      4319,
    ];
  }
  return {
    namespaces: {
      ingress: namespacePlan('probe-ingress', 'ingress'),
      monitor: namespacePlan('probe-monitor', 'monitor'),
      untrusted: namespacePlan('probe-untrusted', 'untrusted', true),
    },
    probes: Object.entries(claims)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([claim, [source, expectation, target]]) => ({
        claim,
        expectation,
        source,
        target,
      })),
    schemaVersion: 1,
    targets: Object.entries(targets)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, [host, port]]) => ({ host, id, port })),
  };
}

function namespacePlan(name, role, emptyPodLabels = false) {
  return {
    name,
    namespaceLabels: {
      'byok-grid.dev/network-drill': 'isolated',
      'network-role': role,
    },
    podLabels: emptyPodLabels ? {} : { 'network-role': role },
  };
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function namespaceFixture(name, labels) {
  return {
    apiVersion: 'v1',
    kind: 'Namespace',
    metadata: { labels, name },
    spec: {},
    status: { phase: 'Active' },
  };
}

function probePod(probe, plan, index) {
  return createNetworkProbePod({
    appName: 'byok-grid',
    connectTimeoutMs: 5_000,
    image: MANIFEST.byTarget.get('maintenance').image,
    index,
    namespace: sourceNamespace(probe, plan, 'byok-grid-drill'),
    podLabels: sourcePodLabels(probe, plan),
    probe,
    release: 'byok-grid',
    runId: RUN_ID,
    target: plan.targetsById.get(probe.target),
  });
}

function completedPodFixture() {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name: 'probe' },
    status: {
      conditions: [{ type: 'Ready', status: 'False' }],
      containerStatuses: [
        {
          name: 'probe',
          restartCount: 0,
          state: { terminated: { exitCode: 0 } },
        },
      ],
      phase: 'Succeeded',
    },
  };
}

function writeExecutable(path, source) {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent) {
    mkdirSync(parent, { recursive: true });
  }
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}
