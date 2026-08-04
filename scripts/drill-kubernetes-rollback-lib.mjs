export const KUBERNETES_ROLLBACK_EVIDENCE_MARKER =
  'BYOK_GRID_KUBERNETES_ROLLBACK_VERIFIED';

const CONFIRMATION = 'controlled-production-candidate';
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const WORKLOADS = Object.freeze({
  'analytics-projector': {
    container: 'analytics-projector',
    minimumReplicas: 1,
    target: 'analytics-projector',
  },
  'connector-runner': {
    container: 'connector-runner',
    minimumReplicas: 1,
    target: 'connector-runner',
  },
  web: { container: 'web', minimumReplicas: 2, target: 'web' },
  worker: {
    container: 'worker',
    minimumReplicas: 1,
    target: 'workflow-worker',
  },
});
const OPTIONAL_COMPONENTS = Object.freeze([
  'analytics-projector',
  'connector-runner',
]);

export function parseRollbackEnvironment(environment) {
  if (environment.BYOK_GRID_KUBERNETES_ROLLBACK_CONFIRM !== CONFIRMATION) {
    fail(
      `Set BYOK_GRID_KUBERNETES_ROLLBACK_CONFIRM=${CONFIRMATION} only for a controlled production-candidate rollback drill.`
    );
  }
  const candidateCommit = required(
    environment,
    'BYOK_GRID_ROLLBACK_CANDIDATE_SHA'
  );
  if (!SHA_PATTERN.test(candidateCommit)) {
    fail('BYOK_GRID_ROLLBACK_CANDIDATE_SHA must be a lowercase commit SHA.');
  }
  const candidateRevision = positiveInteger(
    environment,
    'BYOK_GRID_ROLLBACK_CANDIDATE_REVISION'
  );
  const previousRevision = positiveInteger(
    environment,
    'BYOK_GRID_ROLLBACK_PREVIOUS_REVISION'
  );
  if (previousRevision >= candidateRevision) {
    fail(
      'BYOK_GRID_ROLLBACK_PREVIOUS_REVISION must precede the candidate revision.'
    );
  }
  const candidateVersion = releaseVersion(
    environment,
    'BYOK_GRID_ROLLBACK_CANDIDATE_VERSION'
  );
  if (!candidateVersion.includes('-')) {
    fail('BYOK_GRID_ROLLBACK_CANDIDATE_VERSION must be a prerelease.');
  }
  const previousVersion = releaseVersion(
    environment,
    'BYOK_GRID_ROLLBACK_PREVIOUS_VERSION'
  );
  if (previousVersion === candidateVersion) {
    fail('The rollback and candidate versions must be different.');
  }

  return {
    appOrigin: canonicalHttpsOrigin(
      required(environment, 'BYOK_GRID_ROLLBACK_APP_ORIGIN')
    ),
    candidateCommit,
    candidateDigestManifestPath: required(
      environment,
      'BYOK_GRID_ROLLBACK_CANDIDATE_DIGEST_MANIFEST'
    ),
    candidateRevision,
    candidateVersion,
    context: boundedText(environment, 'BYOK_GRID_ROLLBACK_CONTEXT'),
    namespace: kubernetesLabel(environment, 'BYOK_GRID_ROLLBACK_NAMESPACE'),
    optionalComponents: optionalList(
      environment.BYOK_GRID_ROLLBACK_OPTIONAL_COMPONENTS
    ),
    previousDigestManifestPath: required(
      environment,
      'BYOK_GRID_ROLLBACK_PREVIOUS_DIGEST_MANIFEST'
    ),
    previousRevision,
    previousVersion,
    release: kubernetesLabel(environment, 'BYOK_GRID_ROLLBACK_RELEASE'),
    timeout: '10m',
  };
}

export function validateRollbackContext(actual, expected) {
  if (typeof actual !== 'string' || actual.trim() !== expected) {
    fail('The active kubectl context does not match the declared context.');
  }
}

export function validateHelmVersion(actual) {
  const match =
    /^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)(?:[-+].*)?$/u.exec(
      typeof actual === 'string' ? actual.trim() : ''
    );
  if (
    !match?.groups ||
    Number(match.groups.major) !== 4 ||
    compareVersion(
      [Number(match.groups.minor), Number(match.groups.patch)],
      [2, 3]
    ) < 0
  ) {
    fail('The rollback drill requires Helm 4.2.3 or newer in the Helm 4 line.');
  }
  return actual.trim();
}

export function helmRollbackArguments(config, revision) {
  if (!Number.isSafeInteger(revision) || revision < 1) {
    fail('The Helm rollback revision must be a positive integer.');
  }
  return [
    'rollback',
    config.release,
    String(revision),
    '--cleanup-on-fail',
    `--timeout=${config.timeout}`,
    '--wait=watcher',
  ];
}

export function inspectInitialHelmHistory(value, config) {
  const history = helmHistory(value);
  const latest = history.at(-1);
  if (
    latest.revision !== config.candidateRevision ||
    latest.status !== 'deployed' ||
    latest.appVersion !== config.candidateVersion
  ) {
    fail('The declared candidate is not the currently deployed Helm revision.');
  }
  const previous = history.find(
    (entry) => entry.revision === config.previousRevision
  );
  if (
    !previous ||
    previous.status !== 'superseded' ||
    previous.appVersion !== config.previousVersion
  ) {
    fail('The declared rollback point is not a superseded matching revision.');
  }
  return { history, latest, previous };
}

export function inspectTransitionHelmHistory(value, expected) {
  const history = helmHistory(value);
  const latest = history.at(-1);
  if (
    latest.revision !== expected.revision ||
    latest.status !== 'deployed' ||
    latest.appVersion !== expected.version
  ) {
    fail('Helm history does not show the expected deployed transition.');
  }
  return { history, latest };
}

export function inspectRollbackWorkloads(value, config, manifest) {
  const list = object(value, 'kubectl resource list');
  const items = array(list.items, 'kubectl resource items');
  const expectedComponents = [
    'web',
    'worker',
    ...config.optionalComponents,
  ].sort();
  const deployments = new Map();
  const pods = new Map();

  for (const rawItem of items) {
    const item = object(rawItem, 'Kubernetes resource');
    const metadata = object(item.metadata, 'Kubernetes resource metadata');
    if (metadata.namespace !== config.namespace) {
      fail('A selected Kubernetes resource belongs to another namespace.');
    }
    const labels = object(metadata.labels, 'Kubernetes resource labels');
    if (labels['app.kubernetes.io/instance'] !== config.release) {
      fail('A selected Kubernetes resource belongs to another Helm release.');
    }
    const component = labels['app.kubernetes.io/component'];
    if (
      typeof component !== 'string' ||
      !expectedComponents.includes(component)
    ) {
      fail('The selected release contains an unexpected workload component.');
    }
    const destination =
      item.kind === 'Deployment'
        ? deployments
        : item.kind === 'Pod'
          ? pods
          : undefined;
    if (!destination) {
      fail('The rollback workload query returned an unexpected resource kind.');
    }
    const values = destination.get(component) ?? [];
    values.push(item);
    destination.set(component, values);
  }

  const result = [];
  for (const component of expectedComponents) {
    const definition = WORKLOADS[component];
    const componentDeployments = deployments.get(component) ?? [];
    if (componentDeployments.length !== 1) {
      fail('Each expected component must have exactly one Deployment.');
    }
    const deployment = componentDeployments[0];
    const metadata = object(deployment.metadata, 'Deployment metadata');
    const spec = object(deployment.spec, 'Deployment spec');
    const status = object(deployment.status, 'Deployment status');
    const replicas = integer(spec.replicas, 'Deployment replicas');
    if (
      replicas < definition.minimumReplicas ||
      status.observedGeneration !== metadata.generation ||
      status.replicas !== replicas ||
      status.updatedReplicas !== replicas ||
      status.readyReplicas !== replicas ||
      status.availableReplicas !== replicas ||
      (status.unavailableReplicas ?? 0) !== 0
    ) {
      fail('A rollback Deployment is not stable and fully available.');
    }
    const expectedImage = manifest.byTarget.get(definition.target);
    if (!expectedImage || !DIGEST_PATTERN.test(expectedImage.digest)) {
      fail('The rollback digest manifest is incomplete.');
    }
    const template = object(spec.template, 'Deployment pod template');
    const podSpec = object(template.spec, 'Deployment pod spec');
    const container = findNamedContainer(
      podSpec.containers,
      definition.container,
      'Deployment'
    );
    if (container.image !== expectedImage.image) {
      fail('A Deployment does not use the expected immutable image.');
    }

    const componentPods = (pods.get(component) ?? []).filter(
      (pod) => pod?.metadata?.deletionTimestamp === undefined
    );
    if (componentPods.length !== replicas) {
      fail('A rollback Deployment does not have the expected ready pod count.');
    }
    for (const pod of componentPods) {
      const podStatus = object(pod.status, 'Pod status');
      if (
        podStatus.phase !== 'Running' ||
        !conditionIsTrue(podStatus.conditions, 'Ready')
      ) {
        fail('A rollback Pod is not running and Ready.');
      }
      const liveContainer = findNamedContainer(
        podStatus.containerStatuses,
        definition.container,
        'Pod status'
      );
      if (
        liveContainer.ready !== true ||
        liveContainer.state?.running === undefined ||
        liveContainer.restartCount !== 0 ||
        liveContainer.image !== expectedImage.image ||
        normalizeImageId(liveContainer.imageID) !== expectedImage.image
      ) {
        fail('A rollback Pod does not run the expected healthy image digest.');
      }
    }
    result.push({
      component,
      digest: expectedImage.digest,
      pods: componentPods.length,
      replicas,
    });
  }
  return result;
}

export async function executeKubernetesRollbackDrill(input) {
  const { config, manifests, operations } = input;
  if (manifests.candidate.sha256 === manifests.previous.sha256) {
    fail('The rollback and candidate digest manifests must be different.');
  }
  requireActiveWorkloadDifference(config, manifests);
  const helmVersion = validateHelmVersion(await operations.helmVersion());
  validateRollbackContext(await operations.currentContext(), config.context);
  const initial = inspectInitialHelmHistory(await operations.history(), config);
  const preflightWorkloads = inspectRollbackWorkloads(
    await operations.resources(),
    config,
    manifests.candidate
  );
  const preflightPublic = await operations.verifyPublic(config.appOrigin);

  let mutationAttempted = false;
  let candidateRestored = false;
  try {
    operations.assertContinuation?.();
    mutationAttempted = true;
    await operations.rollback(config.previousRevision);
    operations.assertContinuation?.();
    const rolledBack = inspectTransitionHelmHistory(
      await operations.history(),
      {
        revision: initial.latest.revision + 1,
        version: config.previousVersion,
      }
    );
    const rollbackWorkloads = inspectRollbackWorkloads(
      await operations.resources(),
      config,
      manifests.previous
    );
    const rollbackPublic = await operations.verifyPublic(config.appOrigin);

    operations.assertContinuation?.();
    await operations.rollback(config.candidateRevision);
    operations.assertContinuation?.();
    const restored = inspectTransitionHelmHistory(await operations.history(), {
      revision: initial.latest.revision + 2,
      version: config.candidateVersion,
    });
    const restoredWorkloads = inspectRollbackWorkloads(
      await operations.resources(),
      config,
      manifests.candidate
    );
    const restoredPublic = await operations.verifyPublic(config.appOrigin);
    candidateRestored = true;

    return {
      candidateCommit: config.candidateCommit,
      candidateDigestManifestSha256: manifests.candidate.sha256,
      candidateRevision: config.candidateRevision,
      candidateVersion: config.candidateVersion,
      checks: {
        preflightPublicRequests: publicRequestCount(preflightPublic),
        restoredPublicRequests: publicRequestCount(restoredPublic),
        rollbackPublicRequests: publicRequestCount(rollbackPublic),
      },
      context: config.context,
      helmVersion,
      marker: KUBERNETES_ROLLBACK_EVIDENCE_MARKER,
      namespace: config.namespace,
      previousDigestManifestSha256: manifests.previous.sha256,
      previousRevision: config.previousRevision,
      previousVersion: config.previousVersion,
      release: config.release,
      restoredRevision: restored.latest.revision,
      rollbackRevision: rolledBack.latest.revision,
      workloads: {
        preflight: preflightWorkloads,
        restored: restoredWorkloads,
        rollback: rollbackWorkloads,
      },
      verifiedAt: validDate(input.now?.() ?? new Date()).toISOString(),
    };
  } catch (error) {
    if (mutationAttempted && !candidateRestored) {
      try {
        let history = helmHistory(await operations.history());
        let latest = history.at(-1);
        if (
          latest.status !== 'deployed' ||
          latest.appVersion !== config.candidateVersion
        ) {
          await operations.rollback(config.candidateRevision);
          history = helmHistory(await operations.history());
          latest = history.at(-1);
        }
        if (
          latest.status !== 'deployed' ||
          latest.appVersion !== config.candidateVersion
        ) {
          fail('Automatic candidate restoration did not become deployed.');
        }
        inspectRollbackWorkloads(
          await operations.resources(),
          config,
          manifests.candidate
        );
        await operations.verifyPublic(config.appOrigin);
        candidateRestored = true;
      } catch {
        throw new Error(
          'The rollback drill failed and automatic candidate restoration could not be verified; preserve the current release state and follow the manual recovery runbook.'
        );
      }
    }
    throw error;
  }
}

function requireActiveWorkloadDifference(config, manifests) {
  const targets = [
    WORKLOADS.web.target,
    WORKLOADS.worker.target,
    ...config.optionalComponents.map(
      (component) => WORKLOADS[component].target
    ),
  ];
  if (
    targets.every(
      (target) =>
        manifests.candidate.byTarget.get(target)?.image ===
        manifests.previous.byTarget.get(target)?.image
    )
  ) {
    fail('At least one enabled workload digest must change across rollback.');
  }
}

function helmHistory(value) {
  const rawHistory = array(value, 'Helm history');
  if (rawHistory.length < 2 || rawHistory.length > 256) {
    fail('Helm history must contain a bounded rollback point and candidate.');
  }
  const history = rawHistory.map((rawEntry) => {
    const entry = object(rawEntry, 'Helm history entry');
    return {
      appVersion: requiredString(entry.app_version, 'Helm app version'),
      revision: integerValue(entry.revision, 'Helm revision'),
      status: requiredString(entry.status, 'Helm status').toLowerCase(),
    };
  });
  for (let index = 0; index < history.length; index += 1) {
    if (
      history[index].revision < 1 ||
      (index > 0 && history[index].revision <= history[index - 1].revision)
    ) {
      fail('Helm history revisions must be positive and strictly increasing.');
    }
  }
  return history;
}

function publicRequestCount(value) {
  if (
    !value ||
    value.marker !== 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED' ||
    value.requests !== 4
  ) {
    fail('The public deployment verifier did not return its exact evidence.');
  }
  return value.requests;
}

function optionalList(value) {
  if (value === undefined || value === '') return [];
  const values = value.split(',');
  if (
    values.some((component) => !OPTIONAL_COMPONENTS.includes(component)) ||
    new Set(values).size !== values.length ||
    values.some(
      (component, index) => index > 0 && component <= values[index - 1]
    )
  ) {
    fail(
      'BYOK_GRID_ROLLBACK_OPTIONAL_COMPONENTS must be a sorted unique supported component list.'
    );
  }
  return values;
}

function canonicalHttpsOrigin(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('BYOK_GRID_ROLLBACK_APP_ORIGIN must be a valid URL.');
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    isLocalAddress(parsed.hostname)
  ) {
    fail(
      'BYOK_GRID_ROLLBACK_APP_ORIGIN must be a non-local credential-free HTTPS origin.'
    );
  }
  return parsed.origin;
}

function isLocalAddress(hostname) {
  const lower = hostname.toLowerCase();
  return (
    lower === 'localhost' ||
    lower === '0.0.0.0' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower.endsWith('.localhost')
  );
}

function normalizeImageId(value) {
  if (typeof value !== 'string') return '';
  return value.startsWith('docker-pullable://')
    ? value.slice('docker-pullable://'.length)
    : value;
}

function conditionIsTrue(value, type) {
  return (
    Array.isArray(value) &&
    value.some(
      (condition) => condition?.type === type && condition.status === 'True'
    )
  );
}

function findNamedContainer(value, name, source) {
  const containers = array(value, `${source} containers`);
  const matches = containers.filter((container) => container?.name === name);
  if (containers.length !== 1 || matches.length !== 1) {
    fail(`${source} must contain exactly one expected container.`);
  }
  return object(matches[0], `${source} container`);
}

function releaseVersion(environment, name) {
  const value = required(environment, name);
  if (!RELEASE_VERSION_PATTERN.test(value)) {
    fail(`${name} must be a canonical semantic version.`);
  }
  return value;
}

function positiveInteger(environment, name) {
  const value = required(environment, name);
  if (!/^[1-9]\d{0,8}$/u.test(value)) {
    fail(`${name} must be a positive integer.`);
  }
  return Number(value);
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} is required.`);
  }
  if (value.length > 4_096 || /[\0\r\n]/u.test(value)) {
    fail(`${name} contains invalid data.`);
  }
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

function compareVersion(left, right) {
  return left[0] === right[0] ? left[1] - right[1] : left[0] - right[0];
}

function validDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    fail('The rollback verification clock returned an invalid date.');
  }
  return value;
}

function integer(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${name} is invalid.`);
  return value;
}

function integerValue(value, name) {
  if (typeof value === 'number') return integer(value, name);
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/u.test(value)) {
    return integer(Number(value), name);
  }
  fail(`${name} is invalid.`);
}

function requiredString(value, name) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 253 ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${name} is invalid.`);
  }
  return value;
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`The ${name} response is malformed.`);
  }
  return value;
}

function array(value, name) {
  if (!Array.isArray(value)) fail(`The ${name} response is malformed.`);
  return value;
}

function fail(message) {
  throw new Error(message);
}
