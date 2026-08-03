const CONFIRMATION = 'isolated-preproduction-environment';
const dnsLabel = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const libsqlUrl = /^libsql:\/\/[^/?#]+\/?$/u;

export function parseDrainEnvironment(environment) {
  if (environment.BYOK_GRID_KUBERNETES_DRAIN_CONFIRM !== CONFIRMATION) {
    throw new Error(
      `Set BYOK_GRID_KUBERNETES_DRAIN_CONFIRM=${CONFIRMATION} only for an isolated preproduction environment.`
    );
  }

  const appOrigin = canonicalHttpsOrigin(
    required(environment, 'BYOK_GRID_DRILL_APP_ORIGIN')
  );
  const databaseUrl = canonicalLibsqlUrl(
    required(environment, 'BYOK_GRID_DRILL_DATABASE_URL')
  );
  const email = required(environment, 'BYOK_GRID_DRILL_EMAIL');
  if (
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    /[\r\n]/u.test(email)
  ) {
    throw new Error('BYOK_GRID_DRILL_EMAIL must be a valid email address.');
  }

  return {
    appOrigin,
    context: boundedText(environment, 'BYOK_GRID_DRILL_KUBECTL_CONTEXT'),
    databaseAuthToken: required(
      environment,
      'BYOK_GRID_DRILL_DATABASE_AUTH_TOKEN'
    ),
    databaseUrl,
    deployment: kubernetesSubdomain(
      environment,
      'BYOK_GRID_DRILL_WORKER_DEPLOYMENT'
    ),
    email,
    namespace: kubernetesLabel(environment, 'BYOK_GRID_DRILL_NAMESPACE'),
    timeoutMs: 120_000,
  };
}

export function validateCurrentContext(actual, expected) {
  if (actual.trim() !== expected) {
    throw new Error(
      'The active kubectl context does not match BYOK_GRID_DRILL_KUBECTL_CONTEXT.'
    );
  }
}

export function inspectWorkerDeployment(value) {
  const deployment = object(value, 'deployment');
  const metadata = object(deployment.metadata, 'deployment metadata');
  const spec = object(deployment.spec, 'deployment spec');
  const status = object(deployment.status, 'deployment status');
  const template = object(spec.template, 'deployment pod template');
  const podSpec = object(template.spec, 'deployment pod spec');
  const selector = object(spec.selector, 'deployment selector');
  const labels = object(selector.matchLabels, 'deployment selector labels');

  if (spec.replicas !== 1) {
    throw new Error(
      'The isolated drain drill requires the worker deployment to have exactly one replica.'
    );
  }
  if (
    status.observedGeneration !== metadata.generation ||
    status.replicas !== 1 ||
    status.updatedReplicas !== 1 ||
    status.readyReplicas !== 1 ||
    status.availableReplicas !== 1 ||
    (status.unavailableReplicas ?? 0) !== 0
  ) {
    throw new Error('The worker deployment is not on a stable ready revision.');
  }
  if (
    !Number.isInteger(podSpec.terminationGracePeriodSeconds) ||
    podSpec.terminationGracePeriodSeconds < 90
  ) {
    throw new Error(
      'The worker deployment must provide at least 90 seconds of termination grace.'
    );
  }
  if (
    Array.isArray(selector.matchExpressions) &&
    selector.matchExpressions.length > 0
  ) {
    throw new Error(
      'The drain drill supports deployment selectors made only from matchLabels.'
    );
  }
  const labelEntries = Object.entries(labels);
  if (labelEntries.length === 0) {
    throw new Error('The worker deployment selector has no matchLabels.');
  }

  const containers = array(podSpec.containers, 'deployment containers');
  if (!containers.some((candidate) => candidate?.name === 'worker')) {
    throw new Error('The worker deployment has no worker container.');
  }

  return {
    selector: labelEntries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([key, value]) =>
          `${labelSelectorPart(key)}=${labelSelectorPart(value)}`
      )
      .join(','),
    terminationGracePeriodSeconds: podSpec.terminationGracePeriodSeconds,
  };
}

export function inspectSingleReadyWorkerPod(value) {
  const list = object(value, 'pod list');
  const candidates = array(list.items, 'pod list items').filter(
    (candidate) => candidate?.metadata?.deletionTimestamp === undefined
  );
  if (candidates.length !== 1) {
    throw new Error(
      'The stable one-replica worker deployment must have exactly one non-terminating pod.'
    );
  }

  const pod = object(candidates[0], 'worker pod');
  const metadata = object(pod.metadata, 'worker pod metadata');
  const status = object(pod.status, 'worker pod status');
  if (
    status.phase !== 'Running' ||
    !conditionIsTrue(status.conditions, 'Ready')
  ) {
    throw new Error('The workflow-worker pod is not running and ready.');
  }
  const container = findWorkerContainer(status.containerStatuses);
  if (container.ready !== true || container.state?.running === undefined) {
    throw new Error('The workflow-worker container is not running and ready.');
  }

  return {
    name: requiredString(metadata.name, 'worker pod name'),
    restartCount: integer(container.restartCount, 'worker restart count'),
    uid: requiredString(metadata.uid, 'worker pod UID'),
  };
}

export function inspectRestartedWorkerPod(value, original) {
  const current = inspectSingleReadyWorkerPod(value);
  if (current.name !== original.name || current.uid !== original.uid) {
    throw new Error(
      'The workflow-worker pod was replaced instead of restarting its signalled container.'
    );
  }
  if (current.restartCount !== original.restartCount + 1) {
    throw new Error(
      'The workflow-worker container did not restart exactly once after SIGTERM.'
    );
  }

  const pod = value.items.find(
    (candidate) =>
      candidate?.metadata?.uid === original.uid &&
      candidate.metadata.deletionTimestamp === undefined
  );
  const container = findWorkerContainer(pod?.status?.containerStatuses);
  const terminated = container.lastState?.terminated;
  if (terminated?.exitCode !== 0 || terminated.reason !== 'Completed') {
    throw new Error(
      'The previous workflow-worker process did not record a clean completed exit.'
    );
  }
  return current;
}

export function extractInFlightMarker(text) {
  for (const line of text.split(/\r?\n/u)) {
    const start = line.indexOf('{');
    if (start === -1) continue;
    try {
      const value = JSON.parse(line.slice(start));
      if (
        value?.marker === 'BYOK_GRID_DRAIN_DRILL_IN_FLIGHT' &&
        Number.isInteger(value.rowCount) &&
        value.rowCount === 500 &&
        typeof value.runId === 'string' &&
        /^[0-9a-f-]{36}$/iu.test(value.runId)
      ) {
        return { rowCount: value.rowCount, runId: value.runId };
      }
    } catch {
      // Vitest emits non-JSON status lines around the structured marker.
    }
  }
  return undefined;
}

export function validateDrainLogs(logs) {
  if (!logs.includes('Successfully finished pending tasks.')) {
    throw new Error(
      'The previous worker logs have no pending-task drain confirmation.'
    );
  }
  if (logs.includes('Could not pause worker:')) {
    throw new Error('The previous worker could not pause through Hatchet.');
  }
}

function canonicalHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('BYOK_GRID_DRILL_APP_ORIGIN must be a valid URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    isLoopbackOrUnspecified(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'BYOK_GRID_DRILL_APP_ORIGIN must be a credential-free HTTPS origin with no path, query, or fragment.'
    );
  }
  return parsed.origin;
}

function canonicalLibsqlUrl(value) {
  if (!libsqlUrl.test(value)) {
    throw new Error(
      'BYOK_GRID_DRILL_DATABASE_URL must be a remote libsql:// host with no path, query, or fragment.'
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('BYOK_GRID_DRILL_DATABASE_URL must be a valid URL.');
  }
  if (
    parsed.protocol !== 'libsql:' ||
    parsed.hostname === '' ||
    isLoopbackOrUnspecified(parsed.hostname) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    (parsed.pathname !== '' && parsed.pathname !== '/') ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error(
      'BYOK_GRID_DRILL_DATABASE_URL must be a remote libsql:// host with no embedded credentials.'
    );
  }
  return `libsql://${parsed.host.toLowerCase()}`;
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  if (/[\0\r\n]/u.test(value)) {
    throw new Error(`${name} contains forbidden control characters.`);
  }
  return value;
}

function boundedText(environment, name) {
  const value = required(environment, name);
  if (value.length > 253) throw new Error(`${name} is too long.`);
  return value;
}

function kubernetesLabel(environment, name) {
  const value = boundedText(environment, name);
  if (!dnsLabel.test(value)) {
    throw new Error(`${name} must be a lowercase Kubernetes DNS label.`);
  }
  return value;
}

function kubernetesSubdomain(environment, name) {
  const value = boundedText(environment, name);
  if (!value.split('.').every((label) => dnsLabel.test(label))) {
    throw new Error(`${name} must be a lowercase Kubernetes DNS subdomain.`);
  }
  return value;
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`The ${name} response is malformed.`);
  }
  return value;
}

function array(value, name) {
  if (!Array.isArray(value))
    throw new Error(`The ${name} response is malformed.`);
  return value;
}

function integer(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`The ${name} response is malformed.`);
  }
  return value;
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`The ${name} response is malformed.`);
  }
  return value;
}

function conditionIsTrue(conditions, type) {
  return (
    Array.isArray(conditions) &&
    conditions.some(
      (condition) => condition?.type === type && condition.status === 'True'
    )
  );
}

function findWorkerContainer(containerStatuses) {
  const statuses = array(containerStatuses, 'container statuses');
  const matches = statuses.filter((candidate) => candidate?.name === 'worker');
  if (matches.length !== 1) {
    throw new Error(
      'The workflow-worker pod must expose exactly one worker container status.'
    );
  }
  return object(matches[0], 'worker container status');
}

function labelSelectorPart(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 253 ||
    /[,=!()\s\0\r\n]/u.test(value)
  ) {
    throw new Error('The deployment has an unsupported matchLabels selector.');
  }
  return value;
}

function isLoopbackOrUnspecified(hostname) {
  const normalized = hostname.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '0.0.0.0' ||
    normalized.startsWith('127.') ||
    normalized === '[::]' ||
    normalized === '[::1]'
  );
}
