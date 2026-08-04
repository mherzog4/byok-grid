import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

export const KUBERNETES_RUNTIME_EVIDENCE_MARKER =
  'BYOK_GRID_KUBERNETES_RUNTIME_VERIFIED';

const CONFIRMATION = 'read-only-production-candidate';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const MAXIMUM_DIGEST_MANIFEST_BYTES = 16_384;
const RELEASE_IMAGES = Object.freeze({
  'byok-grid-airbyte-destination': 'airbyte-destination',
  'byok-grid-analytics-projector': 'analytics-projector',
  'byok-grid-connector-runner': 'connector-runner',
  'byok-grid-maintenance': 'maintenance',
  'byok-grid-migration': 'migration',
  'byok-grid-web': 'web',
  'byok-grid-workflow-worker': 'workflow-worker',
});
const OPTIONAL_COMPONENTS = Object.freeze([
  'analytics-projector',
  'connector-runner',
]);
const WORKLOADS = Object.freeze({
  'analytics-projector': {
    container: 'analytics-projector',
    database: true,
    minimumReplicas: 1,
    requiredSecretEnvironment: ['CLICKHOUSE_PASSWORD', 'SQLITE_DATABASE_URL'],
    target: 'analytics-projector',
  },
  'connector-runner': {
    container: 'connector-runner',
    database: false,
    minimumReplicas: 1,
    requiredSecretEnvironment: ['CONNECTOR_RUNNER_SHARED_SECRET'],
    target: 'connector-runner',
  },
  web: {
    container: 'web',
    database: true,
    minimumReplicas: 2,
    requiredSecretEnvironment: [
      'BETTER_AUTH_SECRET',
      'BYOK_GRID_MASTER_KEY',
      'SQLITE_DATABASE_URL',
    ],
    target: 'web',
  },
  worker: {
    container: 'worker',
    database: true,
    minimumReplicas: 1,
    requiredSecretEnvironment: [
      'BYOK_GRID_MASTER_KEY',
      'HATCHET_CLIENT_TOKEN',
      'SQLITE_DATABASE_URL',
    ],
    target: 'workflow-worker',
  },
});
const SENSITIVE_ENVIRONMENT = new Set([
  'BETTER_AUTH_SECRET',
  'BYOK_GRID_ADDITIONAL_MASTER_KEYS',
  'BYOK_GRID_MASTER_KEY',
  'BYOK_GRID_SIGNUP_ALLOWED_EMAILS',
  'CLICKHOUSE_PASSWORD',
  'CONNECTOR_RUNNER_SHARED_SECRET',
  'HATCHET_CLIENT_TOKEN',
  'SMTP_PASSWORD',
  'SMTP_USER',
  'SQLITE_AUTH_TOKEN',
  'SQLITE_DATABASE_URL',
]);

export class KubernetesRuntimeEvidenceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'KubernetesRuntimeEvidenceError';
  }
}

export function parseKubernetesVerificationEnvironment(environment) {
  if (environment.BYOK_GRID_KUBERNETES_VERIFY_CONFIRM !== CONFIRMATION) {
    fail(
      `Set BYOK_GRID_KUBERNETES_VERIFY_CONFIRM=${CONFIRMATION} only for a read-only production-candidate check.`
    );
  }
  const candidateCommit = required(
    environment,
    'BYOK_GRID_KUBERNETES_CANDIDATE_SHA'
  );
  if (!SHA_PATTERN.test(candidateCommit)) {
    fail('BYOK_GRID_KUBERNETES_CANDIDATE_SHA must be a lowercase commit SHA.');
  }
  const optionalComponents = optionalList(
    environment.BYOK_GRID_KUBERNETES_OPTIONAL_COMPONENTS
  );
  return {
    candidateCommit,
    context: boundedText(environment, 'BYOK_GRID_KUBERNETES_CONTEXT'),
    digestManifestPath: required(
      environment,
      'BYOK_GRID_KUBERNETES_DIGEST_MANIFEST'
    ),
    namespace: kubernetesLabel(environment, 'BYOK_GRID_KUBERNETES_NAMESPACE'),
    optionalComponents,
    origin: canonicalHttpsOrigin(
      required(environment, 'BYOK_GRID_KUBERNETES_APP_ORIGIN')
    ),
    release: kubernetesLabel(environment, 'BYOK_GRID_KUBERNETES_RELEASE'),
  };
}

export function validateKubernetesContext(actual, expected) {
  if (typeof actual !== 'string' || actual.trim() !== expected) {
    fail('The active kubectl context does not match the declared context.');
  }
}

export function readReleaseDigestManifest(path) {
  let source;
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size > MAXIMUM_DIGEST_MANIFEST_BYTES
    ) {
      fail('The image digest manifest must be a bounded regular file.');
    }
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof KubernetesRuntimeEvidenceError) throw error;
    throw new KubernetesRuntimeEvidenceError(
      'The image digest manifest could not be read.',
      { cause: error }
    );
  }
  return parseReleaseDigestManifest(source);
}

export function parseReleaseDigestManifest(source) {
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source) > MAXIMUM_DIGEST_MANIFEST_BYTES ||
    !source.endsWith('\n') ||
    source.includes('\r')
  ) {
    fail('IMAGE_DIGESTS.txt must be bounded canonical text.');
  }
  const lines = source.slice(0, -1).split('\n');
  if (
    lines.length !== Object.keys(RELEASE_IMAGES).length ||
    lines.some((line, index) =>
      index === 0 ? line.length === 0 : line <= lines[index - 1]
    )
  ) {
    fail('IMAGE_DIGESTS.txt must contain the canonical complete image set.');
  }
  const byTarget = new Map();
  for (const line of lines) {
    const match =
      /^ghcr\.io\/[a-z0-9._-]+\/(?<image>byok-grid-[a-z0-9-]+)@(?<digest>sha256:[0-9a-f]{64})$/u.exec(
        line
      );
    const target = match?.groups
      ? RELEASE_IMAGES[match.groups.image]
      : undefined;
    if (!match?.groups || !target || byTarget.has(target)) {
      fail('IMAGE_DIGESTS.txt does not match the release image set.');
    }
    byTarget.set(target, { digest: match.groups.digest, image: line });
  }
  if (byTarget.size !== Object.keys(RELEASE_IMAGES).length) {
    fail('IMAGE_DIGESTS.txt is incomplete.');
  }
  return { byTarget, sha256: sha256(source) };
}

export function verifyKubernetesRuntime(resources, input) {
  const list = object(resources, 'kubectl resource list');
  const items = array(list.items, 'kubectl resource items');
  const now = dateOption(input.now ?? new Date(), 'verification clock');
  const clusterVersion = clusterVersionValue(input.clusterVersion);
  const byKind = new Map();
  for (const item of items) {
    const resource = object(item, 'Kubernetes resource');
    const kind = requiredString(resource.kind, 'resource kind');
    const metadata = object(resource.metadata, 'resource metadata');
    if (metadata.namespace !== input.config.namespace) {
      fail('A selected Kubernetes resource belongs to a different namespace.');
    }
    const labels = object(metadata.labels, 'resource labels');
    if (labels['app.kubernetes.io/instance'] !== input.config.release) {
      fail('A selected Kubernetes resource has the wrong Helm release label.');
    }
    const values = byKind.get(kind) ?? [];
    values.push(resource);
    byKind.set(kind, values);
  }

  const deployments = byKind.get('Deployment') ?? [];
  const webDeployment = singleComponent(deployments, 'web', 'Deployment');
  const appName = label(webDeployment, 'app.kubernetes.io/name');
  const expectedComponents = [
    'web',
    'worker',
    ...input.config.optionalComponents,
  ];
  rejectUnexpectedComponents(deployments, expectedComponents, 'Deployment');

  const secretNames = new Set();
  const workloads = [];
  for (const component of expectedComponents) {
    const definition = WORKLOADS[component];
    const deployment = singleComponent(deployments, component, 'Deployment');
    requireApplicationLabels(
      deployment,
      input.config.release,
      appName,
      component
    );
    const inspected = inspectDeployment(
      deployment,
      component,
      definition,
      input.manifest.byTarget.get(definition.target).image,
      secretNames
    );
    const pods = componentItems(byKind.get('Pod') ?? [], component);
    inspectRunningPods(
      pods,
      inspected.replicas,
      definition,
      input.manifest.byTarget.get(definition.target)
    );
    workloads.push({
      component,
      digest: input.manifest.byTarget.get(definition.target).digest,
      pods: pods.length,
      replicas: inspected.replicas,
    });
  }

  const migration = inspectMigration(
    byKind,
    input.config,
    appName,
    input.manifest.byTarget.get('migration'),
    secretNames
  );
  if (secretNames.size !== 1) {
    fail('Chart workloads must use one shared least-privilege Secret object.');
  }

  const services = byKind.get('Service') ?? [];
  const webService = inspectServices(
    services,
    input.config,
    appName,
    expectedComponents
  );
  inspectIngress(
    byKind.get('Ingress') ?? [],
    input.config,
    appName,
    webService
  );
  inspectNetworkPolicies(
    byKind.get('NetworkPolicy') ?? [],
    input.config,
    appName
  );
  inspectWebDisruptionBudget(
    byKind.get('PodDisruptionBudget') ?? [],
    input.config,
    appName,
    workloads.find((workload) => workload.component === 'web').replicas
  );
  inspectOptionalHpa(
    byKind.get('HorizontalPodAutoscaler') ?? [],
    input.config,
    appName,
    webDeployment.metadata.name
  );

  return {
    candidateCommit: input.config.candidateCommit,
    clusterVersion,
    context: input.config.context,
    digestManifestSha256: input.manifest.sha256,
    marker: KUBERNETES_RUNTIME_EVIDENCE_MARKER,
    migration,
    namespace: input.config.namespace,
    optionalComponents: input.config.optionalComponents,
    origin: input.config.origin,
    release: input.config.release,
    secretReferenceSha256: sha256([...secretNames][0]),
    verifiedAt: now.toISOString(),
    workloads,
  };
}

function inspectDeployment(
  deployment,
  component,
  definition,
  expectedImage,
  secretNames
) {
  const metadata = object(deployment.metadata, 'Deployment metadata');
  const spec = object(deployment.spec, 'Deployment spec');
  const status = object(deployment.status, 'Deployment status');
  const replicas = positiveInteger(spec.replicas, 'Deployment replicas');
  if (replicas < definition.minimumReplicas) {
    fail(`${component} has fewer than the production minimum replicas.`);
  }
  if (
    status.observedGeneration !== metadata.generation ||
    status.replicas !== replicas ||
    status.updatedReplicas !== replicas ||
    status.readyReplicas !== replicas ||
    status.availableReplicas !== replicas ||
    (status.unavailableReplicas ?? 0) !== 0
  ) {
    fail(`${component} is not on one stable ready Deployment revision.`);
  }
  const selector = object(spec.selector, 'Deployment selector');
  requireSelector(selector, component);
  const template = object(spec.template, 'Deployment pod template');
  const podSpec = object(template.spec, 'Deployment pod spec');
  inspectPodSpec(
    podSpec,
    component,
    definition,
    expectedImage,
    secretNames,
    true
  );
  return { replicas };
}

function inspectPodSpec(
  podSpec,
  component,
  definition,
  expectedImage,
  secretNames,
  requireProbes
) {
  if (
    podSpec.automountServiceAccountToken !== false ||
    !podSpec.serviceAccountName ||
    podSpec.serviceAccountName === 'default'
  ) {
    fail(`${component} must use a dedicated token-free ServiceAccount.`);
  }
  const podSecurity = object(podSpec.securityContext, 'pod security context');
  if (
    podSecurity.runAsNonRoot !== true ||
    podSecurity.seccompProfile?.type !== 'RuntimeDefault'
  ) {
    fail(`${component} does not enforce the pod security baseline.`);
  }
  if (
    Array.isArray(podSpec.volumes) &&
    podSpec.volumes.some((volume) => volume?.hostPath !== undefined)
  ) {
    fail(`${component} must not mount hostPath volumes.`);
  }
  const containers = array(podSpec.containers, 'pod containers');
  const matches = containers.filter(
    (container) => container?.name === definition.container
  );
  if (matches.length !== 1 || containers.length !== 1) {
    fail(`${component} must contain exactly its chart-owned container.`);
  }
  const container = matches[0];
  if (container.image !== expectedImage) {
    fail(`${component} is not pinned to its release image digest.`);
  }
  const security = object(container.securityContext, 'container security');
  if (
    security.allowPrivilegeEscalation !== false ||
    security.readOnlyRootFilesystem !== true ||
    !Array.isArray(security.capabilities?.drop) ||
    !security.capabilities.drop.includes('ALL') ||
    security.privileged === true
  ) {
    fail(`${component} does not enforce the container security baseline.`);
  }
  if (requireProbes) {
    for (const probe of ['livenessProbe', 'readinessProbe', 'startupProbe']) {
      object(container[probe], `${component} ${probe}`);
    }
  }
  inspectResources(container.resources, component);
  inspectEnvironment(container, component, definition, secretNames);
}

function inspectEnvironment(container, component, definition, secretNames) {
  const environment = array(container.env ?? [], `${component} environment`);
  if (
    Array.isArray(container.envFrom) &&
    container.envFrom.some(
      (entry) =>
        entry?.configMapRef === undefined || entry?.secretRef !== undefined
    )
  ) {
    fail(`${component} uses an unbounded environment source.`);
  }
  const byName = new Map();
  for (const entry of environment) {
    if (!entry || typeof entry.name !== 'string' || byName.has(entry.name)) {
      fail(`${component} has malformed or duplicate environment entries.`);
    }
    byName.set(entry.name, entry);
    if (SENSITIVE_ENVIRONMENT.has(entry.name)) {
      const reference = entry.valueFrom?.secretKeyRef;
      if (
        entry.value !== undefined ||
        !reference ||
        typeof reference.name !== 'string' ||
        !reference.name ||
        typeof reference.key !== 'string' ||
        !reference.key
      ) {
        fail(
          `${component} exposes sensitive configuration outside Secret refs.`
        );
      }
      secretNames.add(reference.name);
    }
  }
  for (const name of definition.requiredSecretEnvironment) {
    if (!byName.has(name)) {
      fail(
        `${component} is missing a required Secret-backed environment value.`
      );
    }
  }
  if (
    definition.database &&
    byName.get('BYOK_GRID_DATABASE_MODE')?.value !== 'remote'
  ) {
    fail(`${component} is not configured for remote libSQL mode.`);
  }
}

function inspectResources(value, component) {
  const resources = object(value, `${component} resources`);
  const requests = object(resources.requests, `${component} resource requests`);
  const limits = object(resources.limits, `${component} resource limits`);
  for (const [group, values, names] of [
    ['requests', requests, ['cpu', 'memory']],
    ['limits', limits, ['memory']],
  ]) {
    for (const name of names) {
      if (typeof values[name] !== 'string' || values[name].length === 0) {
        fail(`${component} must declare ${group}.${name}.`);
      }
    }
  }
}

function inspectRunningPods(pods, replicas, definition, expected) {
  if (pods.length !== replicas) {
    fail('A Deployment does not have the expected number of live pods.');
  }
  for (const pod of pods) {
    const metadata = object(pod.metadata, 'Pod metadata');
    const status = object(pod.status, 'Pod status');
    if (
      metadata.deletionTimestamp !== undefined ||
      status.phase !== 'Running' ||
      !conditionIsTrue(status.conditions, 'Ready')
    ) {
      fail('A Deployment pod is not stably running and ready.');
    }
    inspectContainerStatus(
      status.containerStatuses,
      definition.container,
      expected,
      true
    );
  }
}

function inspectMigration(byKind, config, appName, expected, secretNames) {
  const jobs = componentItems(byKind.get('Job') ?? [], 'migration');
  if (jobs.length !== 1) fail('The release must retain one migration Job.');
  const job = jobs[0];
  requireApplicationLabels(job, config.release, appName, 'migration');
  const metadata = object(job.metadata, 'migration Job metadata');
  if (
    metadata.annotations?.['helm.sh/hook'] !== 'pre-install,pre-upgrade' ||
    metadata.annotations?.['helm.sh/hook-delete-policy'] !==
      'before-hook-creation'
  ) {
    fail('The migration Job has the wrong Helm hook lifecycle.');
  }
  const spec = object(job.spec, 'migration Job spec');
  const status = object(job.status, 'migration Job status');
  if (
    status.succeeded !== 1 ||
    (status.failed ?? 0) !== 0 ||
    !conditionIsTrue(status.conditions, 'Complete') ||
    typeof status.completionTime !== 'string'
  ) {
    fail('The migration Job did not complete exactly once successfully.');
  }
  const template = object(spec.template, 'migration pod template');
  inspectPodSpec(
    object(template.spec, 'migration pod spec'),
    'migration',
    {
      container: 'migrate',
      database: true,
      requiredSecretEnvironment: ['SQLITE_DATABASE_URL'],
    },
    expected.image,
    secretNames,
    false
  );
  const pods = componentItems(byKind.get('Pod') ?? [], 'migration');
  if (pods.length !== 1) fail('The release must retain one migration Job pod.');
  const podStatus = object(pods[0].status, 'migration Pod status');
  if (podStatus.phase !== 'Succeeded') {
    fail('The migration Job pod did not finish successfully.');
  }
  inspectContainerStatus(
    podStatus.containerStatuses,
    'migrate',
    expected,
    false
  );
  return {
    completedAt: canonicalTimestamp(
      status.completionTime,
      'migration completion'
    ),
    digest: expected.digest,
    job: requiredString(metadata.name, 'migration Job name'),
  };
}

function inspectContainerStatus(
  statuses,
  containerName,
  expected,
  requireReady
) {
  const matches = array(statuses, 'container statuses').filter(
    (status) => status?.name === containerName
  );
  if (matches.length !== 1) fail('A pod has the wrong container status set.');
  const status = matches[0];
  if (
    status.image !== expected.image ||
    typeof status.imageID !== 'string' ||
    !status.imageID.endsWith(expected.digest) ||
    status.restartCount !== 0 ||
    (requireReady &&
      (status.ready !== true || status.state?.running === undefined)) ||
    (!requireReady && status.state?.terminated?.exitCode !== 0)
  ) {
    fail('A pod is not running the expected immutable image cleanly.');
  }
}

function inspectServices(services, config, appName, expectedComponents) {
  rejectUnexpectedComponents(
    services,
    expectedComponents.filter((component) =>
      ['connector-runner', 'web'].includes(component)
    ),
    'Service'
  );
  for (const service of services) {
    const spec = object(service.spec, 'Service spec');
    if (
      spec.type !== 'ClusterIP' ||
      spec.externalName !== undefined ||
      spec.loadBalancerIP !== undefined ||
      (Array.isArray(spec.externalIPs) && spec.externalIPs.length > 0) ||
      array(spec.ports, 'Service ports').some(
        (port) => port?.nodePort !== undefined
      )
    ) {
      fail('Chart services must remain cluster-internal.');
    }
  }
  const web = singleComponent(services, 'web', 'Service');
  requireApplicationLabels(web, config.release, appName, 'web');
  requireSelector(object(web.spec, 'web Service spec'), 'web');
  return requiredString(web.metadata.name, 'web Service name');
}

function inspectIngress(ingresses, config, appName, webService) {
  if (ingresses.length !== 1)
    fail('The release must expose exactly one Ingress.');
  const ingress = ingresses[0];
  requireApplicationLabels(ingress, config.release, appName);
  const spec = object(ingress.spec, 'Ingress spec');
  if (
    !spec.ingressClassName &&
    !ingress.metadata.annotations?.['kubernetes.io/ingress.class']
  ) {
    fail('The Ingress must name its controller class explicitly.');
  }
  const host = new URL(config.origin).hostname;
  const rules = array(spec.rules, 'Ingress rules');
  if (rules.length !== 1 || rules[0]?.host !== host) {
    fail('The Ingress host does not match the canonical application origin.');
  }
  const paths = array(rules[0]?.http?.paths, 'Ingress paths');
  if (
    paths.length === 0 ||
    paths.some(
      (path) =>
        path?.path !== '/' ||
        path?.backend?.service?.name !== webService ||
        path?.backend?.service?.port?.number === undefined
    )
  ) {
    fail('The Ingress does not route the canonical root to the web Service.');
  }
  const tls = array(spec.tls, 'Ingress TLS');
  if (
    tls.length === 0 ||
    !tls.some(
      (entry) =>
        typeof entry?.secretName === 'string' &&
        entry.secretName.length > 0 &&
        Array.isArray(entry.hosts) &&
        entry.hosts.includes(host)
    )
  ) {
    fail('The canonical Ingress host has no TLS Secret binding.');
  }
  if (
    !Array.isArray(ingress.status?.loadBalancer?.ingress) ||
    ingress.status.loadBalancer.ingress.length === 0
  ) {
    fail('The Ingress controller has not admitted a public endpoint.');
  }
}

function inspectNetworkPolicies(policies, config, appName) {
  if (policies.length < 6) {
    fail('The release has an incomplete NetworkPolicy set.');
  }
  for (const policy of policies) rejectWorldAccess(policy);
  const defaultIngress = policies.filter((policy) => {
    const spec = policy.spec;
    return (
      policyTypes(spec).includes('Ingress') &&
      emptyRules(spec.ingress) &&
      selectorMatches(spec.podSelector, appName, config.release)
    );
  });
  if (defaultIngress.length !== 1)
    fail('The release has no unique default-deny ingress policy.');

  const defaultEgress = policies.filter((policy) => {
    const spec = policy.spec;
    const requiredComponents = ['web', 'worker'];
    if (config.optionalComponents.includes('analytics-projector')) {
      requiredComponents.push('analytics-projector');
    }
    return (
      policyTypes(spec).includes('Egress') &&
      emptyRules(spec.egress) &&
      selectorExpressionIncludes(
        spec.podSelector,
        'app.kubernetes.io/component',
        requiredComponents
      )
    );
  });
  if (defaultEgress.length !== 1)
    fail('The release has no unique default-deny runtime egress policy.');

  const webIngress = componentPolicies(policies, 'web', 'Ingress').filter(
    (policy) => !emptyRules(policy.spec.ingress)
  );
  if (
    webIngress.length !== 1 ||
    !rulesHaveSourcesAndPorts(webIngress[0].spec.ingress, [3000])
  ) {
    fail(
      'The web ingress policy does not admit only explicit peers on port 3000.'
    );
  }
  const monitoring = componentPolicies(policies, 'worker', 'Ingress').filter(
    (policy) => !emptyRules(policy.spec.ingress)
  );
  if (
    monitoring.length !== 1 ||
    !rulesHaveAtLeastPorts(monitoring[0].spec.ingress, 2)
  ) {
    fail('The worker monitoring ingress policy is incomplete.');
  }
  for (const component of ['web', 'worker']) {
    const policiesForComponent = componentPolicies(
      policies,
      component,
      'Egress'
    ).filter((policy) => !emptyRules(policy.spec.egress));
    if (policiesForComponent.length !== 1) {
      fail(`${component} has no explicit runtime egress policy.`);
    }
  }
  if (config.optionalComponents.includes('analytics-projector')) {
    const analytics = componentPolicies(
      policies,
      'analytics-projector',
      'Egress'
    ).filter((policy) => !emptyRules(policy.spec.egress));
    if (analytics.length !== 1)
      fail('The analytics projector has no explicit egress policy.');
  }
  if (config.optionalComponents.includes('connector-runner')) {
    const runner = componentPolicies(policies, 'connector-runner', 'Egress');
    if (
      runner.length !== 1 ||
      !policyTypes(runner[0].spec).includes('Ingress') ||
      !emptyRules(runner[0].spec.egress) ||
      !rulesHaveComponentSourcesAndPorts(
        runner[0].spec.ingress,
        'worker',
        [4319]
      )
    ) {
      fail(
        'The connector runner must admit only worker RPC and deny all egress.'
      );
    }
  }
}

function rulesHaveComponentSourcesAndPorts(rules, component, expectedPorts) {
  const values = array(rules, 'NetworkPolicy ingress rules');
  if (!rulesHaveSourcesAndPorts(values, expectedPorts)) return false;
  return values.every((rule) =>
    rule.from.every(
      (peer) =>
        peer?.podSelector?.matchLabels?.['app.kubernetes.io/component'] ===
        component
    )
  );
}

function inspectWebDisruptionBudget(pdbs, config, appName, webReplicas) {
  const web = componentItems(pdbs, 'web');
  if (web.length !== 1) fail('The multi-replica web deployment needs one PDB.');
  requireApplicationLabels(web[0], config.release, appName, 'web');
  const spec = object(web[0].spec, 'web PDB spec');
  const status = object(web[0].status, 'web PDB status');
  requireSelector(spec, 'web');
  if (
    !Number.isInteger(spec.minAvailable) ||
    spec.minAvailable < 1 ||
    status.observedGeneration !== web[0].metadata.generation ||
    status.currentHealthy !== webReplicas ||
    status.currentHealthy < status.desiredHealthy
  ) {
    fail(
      'The web PodDisruptionBudget is not healthy for the live replica set.'
    );
  }
}

function inspectOptionalHpa(hpas, config, appName, webDeploymentName) {
  if (hpas.length > 1) fail('The release has an unexpected HPA set.');
  if (hpas.length === 0) return;
  const hpa = hpas[0];
  requireApplicationLabels(hpa, config.release, appName, 'web');
  const spec = object(hpa.spec, 'HPA spec');
  if (
    spec.scaleTargetRef?.kind !== 'Deployment' ||
    spec.scaleTargetRef?.name !== webDeploymentName ||
    !Number.isInteger(spec.minReplicas) ||
    spec.minReplicas < 2 ||
    !Number.isInteger(spec.maxReplicas) ||
    spec.maxReplicas < spec.minReplicas
  ) {
    fail('The web HPA has an unsafe production replica envelope.');
  }
}

function rulesHaveSourcesAndPorts(rules, expectedPorts) {
  const values = array(rules, 'NetworkPolicy ingress rules');
  const ports = [];
  for (const rule of values) {
    if (!Array.isArray(rule?.from) || rule.from.length === 0) return false;
    for (const port of array(rule.ports, 'NetworkPolicy ports')) {
      if (!Number.isInteger(port?.port)) return false;
      ports.push(port.port);
    }
  }
  return sameArray(
    [...new Set(ports)].sort((a, b) => a - b),
    expectedPorts
  );
}

function rulesHaveAtLeastPorts(rules, minimum) {
  const values = array(rules, 'NetworkPolicy ingress rules');
  const ports = new Set();
  for (const rule of values) {
    if (!Array.isArray(rule?.from) || rule.from.length === 0) return false;
    for (const port of array(rule.ports, 'NetworkPolicy ports')) {
      if (!Number.isInteger(port?.port)) return false;
      ports.add(port.port);
    }
  }
  return ports.size >= minimum;
}

function componentPolicies(policies, component, type) {
  return policies.filter(
    (policy) =>
      policyTypes(policy.spec).includes(type) &&
      policy.spec?.podSelector?.matchLabels?.['app.kubernetes.io/component'] ===
        component
  );
}

function policyTypes(spec) {
  return array(spec?.policyTypes, 'NetworkPolicy policyTypes');
}

function emptyRules(value) {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

function selectorMatches(selector, appName, release) {
  return (
    selector?.matchLabels?.['app.kubernetes.io/name'] === appName &&
    selector?.matchLabels?.['app.kubernetes.io/instance'] === release
  );
}

function selectorExpressionIncludes(selector, key, requiredValues) {
  return (
    Array.isArray(selector?.matchExpressions) &&
    selector.matchExpressions.some(
      (expression) =>
        expression?.key === key &&
        expression.operator === 'In' &&
        Array.isArray(expression.values) &&
        requiredValues.every((value) => expression.values.includes(value))
    )
  );
}

function rejectWorldAccess(value) {
  const pending = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || typeof current !== 'object') continue;
    if (
      current.ipBlock?.cidr === '0.0.0.0/0' ||
      current.ipBlock?.cidr === '::/0'
    ) {
      fail('A NetworkPolicy grants world-routable access.');
    }
    pending.push(
      ...(Array.isArray(current) ? current : Object.values(current))
    );
  }
}

function requireApplicationLabels(resource, release, appName, component) {
  if (
    label(resource, 'app.kubernetes.io/instance') !== release ||
    label(resource, 'app.kubernetes.io/name') !== appName ||
    (component !== undefined &&
      label(resource, 'app.kubernetes.io/component') !== component) ||
    label(resource, 'app.kubernetes.io/managed-by') !== 'Helm'
  ) {
    fail('A chart resource has inconsistent ownership labels.');
  }
}

function requireSelector(value, component) {
  const selector =
    value?.matchLabels ?? value?.selector?.matchLabels ?? value?.selector;
  if (selector?.['app.kubernetes.io/component'] !== component) {
    fail('A workload or Service has the wrong component selector.');
  }
}

function rejectUnexpectedComponents(resources, expected, kind) {
  const components = resources.map((resource) =>
    label(resource, 'app.kubernetes.io/component')
  );
  if (
    components.length !== expected.length ||
    !sameArray([...components].sort(), [...expected].sort())
  ) {
    fail(`The release has an unexpected ${kind} component set.`);
  }
}

function singleComponent(resources, component, kind) {
  const matches = componentItems(resources, component);
  if (matches.length !== 1) {
    fail(`The release must contain exactly one ${component} ${kind}.`);
  }
  return matches[0];
}

function componentItems(resources, component) {
  return resources.filter(
    (resource) =>
      resource?.metadata?.labels?.['app.kubernetes.io/component'] === component
  );
}

function label(resource, name) {
  return requiredString(resource?.metadata?.labels?.[name], `label ${name}`);
}

function conditionIsTrue(conditions, type) {
  return (
    Array.isArray(conditions) &&
    conditions.some(
      (condition) => condition?.type === type && condition.status === 'True'
    )
  );
}

function optionalList(value) {
  if (value === undefined || value === '') return [];
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) {
    fail('BYOK_GRID_KUBERNETES_OPTIONAL_COMPONENTS is invalid.');
  }
  const items = value.split(',');
  if (
    new Set(items).size !== items.length ||
    !sameArray([...items].sort(), items) ||
    items.some((item) => !OPTIONAL_COMPONENTS.includes(item))
  ) {
    fail(
      'BYOK_GRID_KUBERNETES_OPTIONAL_COMPONENTS must be a sorted unique supported list.'
    );
  }
  return items;
}

function canonicalHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('BYOK_GRID_KUBERNETES_APP_ORIGIN must be a valid HTTPS origin.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
  ) {
    fail(
      'BYOK_GRID_KUBERNETES_APP_ORIGIN must be a public credential-free HTTPS origin.'
    );
  }
  return parsed.origin;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} is required.`);
  }
  if (/[\0\r\n]/u.test(value)) fail(`${name} contains control characters.`);
  return value;
}

function boundedText(environment, name) {
  const value = required(environment, name);
  if (value.length > 253) fail(`${name} is too long.`);
  return value;
}

function kubernetesLabel(environment, name) {
  const value = boundedText(environment, name);
  if (!DNS_LABEL_PATTERN.test(value)) {
    fail(`${name} must be a lowercase Kubernetes DNS label.`);
  }
  return value;
}

function clusterVersionValue(value) {
  if (
    typeof value !== 'string' ||
    !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)
  ) {
    fail('kubectl returned an invalid Kubernetes server version.');
  }
  return value;
}

function canonicalTimestamp(value, name) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail(`The ${name} is invalid.`);
  return parsed.toISOString();
}

function dateOption(value, name) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(`The ${name} is invalid.`);
  }
  return value;
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

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) fail(`The ${name} is malformed.`);
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`The ${name} response is malformed.`);
  }
  return value;
}

function sameArray(left, right) {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new KubernetesRuntimeEvidenceError(message);
}
