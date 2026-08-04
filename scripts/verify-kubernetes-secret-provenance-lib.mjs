import { createHash } from 'node:crypto';

export const KUBERNETES_SECRET_PROVENANCE_EVIDENCE_MARKER =
  'BYOK_GRID_KUBERNETES_EXTERNAL_SECRET_PROVENANCE_VERIFIED';

const CONFIRMATION = 'read-only-external-secret-candidate';
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_PATTERN =
  /^(?<repository>[a-z0-9](?:[a-z0-9._:/-]*[a-z0-9])?)@(?<digest>sha256:[0-9a-f]{64})$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SECRET_KEY_PATTERN = /^[A-Za-z0-9](?:[-._A-Za-z0-9]{0,252})$/u;
const LABEL_KEY_PATTERN =
  /^(?:(?:[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?\/)?[A-Za-z0-9](?:[-._A-Za-z0-9]{0,61}[A-Za-z0-9])?$/u;
const LABEL_VALUE_PATTERN =
  /^(?:[A-Za-z0-9](?:[-._A-Za-z0-9]{0,61}[A-Za-z0-9])?)?$/u;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const PROTECTED_NAMESPACES = new Set([
  'default',
  'kube-node-lease',
  'kube-public',
  'kube-system',
]);
const STORE_KINDS = new Set(['ClusterSecretStore', 'SecretStore']);

export class KubernetesSecretProvenanceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'KubernetesSecretProvenanceError';
  }
}

export function parseKubernetesSecretProvenanceEnvironment(environment) {
  if (environment.BYOK_GRID_EXTERNAL_SECRET_VERIFY_CONFIRM !== CONFIRMATION) {
    fail(
      `Set BYOK_GRID_EXTERNAL_SECRET_VERIFY_CONFIRM=${CONFIRMATION} only for a read-only production-candidate check.`
    );
  }
  const candidateCommit = required(
    environment,
    'BYOK_GRID_EXTERNAL_SECRET_CANDIDATE_SHA'
  );
  if (!SHA_PATTERN.test(candidateCommit)) {
    fail(
      'BYOK_GRID_EXTERNAL_SECRET_CANDIDATE_SHA must be a lowercase commit SHA.'
    );
  }
  const namespace = kubernetesName(
    environment,
    'BYOK_GRID_EXTERNAL_SECRET_NAMESPACE'
  );
  const controllerNamespace = kubernetesName(
    environment,
    'BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_NAMESPACE'
  );
  if (
    PROTECTED_NAMESPACES.has(namespace) ||
    PROTECTED_NAMESPACES.has(controllerNamespace) ||
    namespace === controllerNamespace
  ) {
    fail(
      'Application and controller namespaces must be distinct non-system namespaces.'
    );
  }
  const storeKind = required(
    environment,
    'BYOK_GRID_EXTERNAL_SECRET_STORE_KIND'
  );
  if (!STORE_KINDS.has(storeKind)) {
    fail(
      'BYOK_GRID_EXTERNAL_SECRET_STORE_KIND must be SecretStore or ClusterSecretStore.'
    );
  }
  const controllerImage = boundedText(
    environment,
    'BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_IMAGE',
    512
  );
  const image = IMAGE_PATTERN.exec(controllerImage)?.groups;
  if (!image || !DIGEST_PATTERN.test(image.digest)) {
    fail(
      'BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_IMAGE must be an immutable lowercase OCI digest reference.'
    );
  }
  return {
    candidateCommit,
    context: boundedText(environment, 'BYOK_GRID_EXTERNAL_SECRET_CONTEXT', 253),
    controllerContainer: kubernetesName(
      environment,
      'BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_CONTAINER'
    ),
    controllerDeployment: kubernetesName(
      environment,
      'BYOK_GRID_EXTERNAL_SECRET_CONTROLLER_DEPLOYMENT'
    ),
    controllerDigest: image.digest,
    controllerImage,
    controllerNamespace,
    expectedSecretKeys: sortedSecretKeys(
      environment.BYOK_GRID_EXTERNAL_SECRET_EXPECTED_KEYS
    ),
    externalSecretName: kubernetesName(
      environment,
      'BYOK_GRID_EXTERNAL_SECRET_NAME'
    ),
    maxRefreshAgeSeconds: boundedInteger(
      environment.BYOK_GRID_EXTERNAL_SECRET_MAX_REFRESH_AGE_SECONDS,
      'BYOK_GRID_EXTERNAL_SECRET_MAX_REFRESH_AGE_SECONDS',
      7_200,
      60,
      86_400
    ),
    namespace,
    storeKind,
    storeName: kubernetesName(
      environment,
      'BYOK_GRID_EXTERNAL_SECRET_STORE_NAME'
    ),
  };
}

export function validateKubernetesSecretContext(actual, expected) {
  if (typeof actual !== 'string' || actual.trim() !== expected) {
    fail('The active kubectl context does not match the declared context.');
  }
}

export function inspectExternalSecret(value, config, now = new Date()) {
  const resource = object(value, 'ExternalSecret');
  if (
    resource.apiVersion !== 'external-secrets.io/v1' ||
    resource.kind !== 'ExternalSecret'
  ) {
    fail('The selected resource is not an ExternalSecret v1 object.');
  }
  const metadata = inspectNamespacedMetadata(
    resource.metadata,
    config.externalSecretName,
    config.namespace,
    'ExternalSecret'
  );
  const spec = allowedObject(
    resource.spec,
    'ExternalSecret spec',
    [
      'data',
      'dataFrom',
      'refreshInterval',
      'refreshPolicy',
      'secretStoreRef',
      'target',
    ],
    ['data', 'refreshInterval', 'refreshPolicy', 'secretStoreRef', 'target']
  );
  if (spec.refreshPolicy !== 'Periodic') {
    fail('The ExternalSecret must use Periodic refresh.');
  }
  const refreshIntervalSeconds = durationSeconds(spec.refreshInterval);
  if (
    refreshIntervalSeconds > 86_400 ||
    config.maxRefreshAgeSeconds < refreshIntervalSeconds ||
    config.maxRefreshAgeSeconds > refreshIntervalSeconds * 2 + 300
  ) {
    fail('The ExternalSecret refresh and maximum-age envelope is unsafe.');
  }
  const storeRef = exactObject(
    spec.secretStoreRef,
    'ExternalSecret secretStoreRef',
    ['kind', 'name']
  );
  if (
    storeRef.kind !== config.storeKind ||
    storeRef.name !== config.storeName
  ) {
    fail('The ExternalSecret uses the wrong SecretStore reference.');
  }
  const target = exactObject(spec.target, 'ExternalSecret target', [
    'creationPolicy',
    'deletionPolicy',
    'name',
  ]);
  if (
    target.creationPolicy !== 'Owner' ||
    target.deletionPolicy !== 'Retain' ||
    !DNS_LABEL_PATTERN.test(target.name)
  ) {
    fail('The ExternalSecret target ownership policy is unsafe.');
  }
  if (spec.dataFrom !== undefined && !emptyArray(spec.dataFrom)) {
    fail('The ExternalSecret must not use broad dataFrom imports.');
  }
  const bindings = inspectSecretBindings(spec.data, config.expectedSecretKeys);

  const status = object(resource.status, 'ExternalSecret status');
  const ready = readyCondition(status.conditions, 'ExternalSecret');
  if (ready.reason !== 'SecretSynced') {
    fail('The ExternalSecret Ready condition is not a successful sync.');
  }
  const refreshTime = timestamp(status.refreshTime, 'ExternalSecret refresh');
  const verificationTime = dateOption(now, 'verification clock');
  if (
    refreshTime.getTime() > verificationTime.getTime() + CLOCK_SKEW_MS ||
    verificationTime.getTime() - refreshTime.getTime() >
      config.maxRefreshAgeSeconds * 1_000 ||
    ready.lastTransitionTime.getTime() > refreshTime.getTime()
  ) {
    fail('The ExternalSecret has no recent trustworthy refresh.');
  }
  const syncedResourceVersion = boundedString(
    status.syncedResourceVersion,
    'ExternalSecret synced resource version',
    512
  );
  if (!syncedResourceVersion.startsWith(`${metadata.generation}-`)) {
    fail('The ExternalSecret status is not bound to its current generation.');
  }
  return {
    bindingSetSha256: sha256(canonicalJson(bindings)),
    externalSecretGeneration: metadata.generation,
    externalSecretReferenceSha256: sha256(
      `${config.namespace}/${config.externalSecretName}`
    ),
    refreshIntervalSeconds,
    refreshTime: refreshTime.toISOString(),
    secretKeyCount: bindings.length,
    secretKeySetSha256: sha256(
      canonicalJson(bindings.map(({ secretKey }) => secretKey))
    ),
    secretReferenceSha256: sha256(target.name),
    storeReferenceSha256: sha256(
      `${config.storeKind}/${
        config.storeKind === 'SecretStore' ? config.namespace : '_cluster'
      }/${config.storeName}`
    ),
    syncVersionSha256: sha256(syncedResourceVersion),
  };
}

export function inspectSecretStore(value, config, now = new Date()) {
  const resource = object(value, 'SecretStore');
  if (
    resource.apiVersion !== 'external-secrets.io/v1' ||
    resource.kind !== config.storeKind
  ) {
    fail('The selected resource is not the declared SecretStore v1 object.');
  }
  const metadata = object(resource.metadata, 'SecretStore metadata');
  if (
    metadata.name !== config.storeName ||
    metadata.deletionTimestamp !== undefined ||
    !Number.isInteger(metadata.generation) ||
    metadata.generation < 1 ||
    (config.storeKind === 'SecretStore'
      ? metadata.namespace !== config.namespace
      : metadata.namespace !== undefined && metadata.namespace !== '')
  ) {
    fail('The SecretStore metadata does not match the declared resource.');
  }
  const spec = object(resource.spec, 'SecretStore spec');
  const provider = object(spec.provider, 'SecretStore provider');
  if (Object.keys(provider).length !== 1) {
    fail('The SecretStore must declare exactly one provider.');
  }
  const ready = readyCondition(resource.status?.conditions, 'SecretStore');
  const verificationTime = dateOption(now, 'verification clock');
  if (
    ready.lastTransitionTime.getTime() >
    verificationTime.getTime() + CLOCK_SKEW_MS
  ) {
    fail('The SecretStore Ready condition is from the future.');
  }
  return {
    secretStoreGeneration: metadata.generation,
    secretStoreSpecSha256: sha256(canonicalJson(spec)),
  };
}

export function inspectExternalSecretsControllerDeployment(value, config) {
  const deployment = object(value, 'controller Deployment');
  if (deployment.apiVersion !== 'apps/v1' || deployment.kind !== 'Deployment') {
    fail('The selected controller resource is not an apps/v1 Deployment.');
  }
  const metadata = inspectNamespacedMetadata(
    deployment.metadata,
    config.controllerDeployment,
    config.controllerNamespace,
    'controller Deployment'
  );
  const spec = object(deployment.spec, 'controller Deployment spec');
  const status = object(deployment.status, 'controller Deployment status');
  const replicas = positiveInteger(spec.replicas, 'controller replicas');
  if (
    replicas > 10 ||
    status.observedGeneration !== metadata.generation ||
    status.replicas !== replicas ||
    status.updatedReplicas !== replicas ||
    status.readyReplicas !== replicas ||
    status.availableReplicas !== replicas ||
    (status.unavailableReplicas ?? 0) !== 0
  ) {
    fail('The controller Deployment is not on one stable ready revision.');
  }
  const selector = exactObject(spec.selector, 'controller selector', [
    'matchLabels',
  ]);
  const matchLabels = labelMap(selector.matchLabels, 'controller selector');
  const template = object(spec.template, 'controller pod template');
  const templateLabels = labelMap(
    template.metadata?.labels,
    'controller pod labels'
  );
  if (
    Object.entries(matchLabels).some(
      ([key, expected]) => templateLabels[key] !== expected
    )
  ) {
    fail('The controller pod template does not match its selector.');
  }
  const pod = inspectControllerPodSpec(template.spec, config);
  return { matchLabels, replicas, serviceAccountName: pod.serviceAccountName };
}

export function inspectExternalSecretsControllerPods(
  value,
  config,
  deployment
) {
  const list = object(value, 'controller Pod list');
  if (list.kind !== 'List') fail('kubectl returned the wrong Pod list kind.');
  const items = array(list.items, 'controller Pods');
  if (items.length !== deployment.replicas) {
    fail('The controller Deployment has an unexpected live Pod count.');
  }
  for (const pod of items) {
    const metadata = object(pod.metadata, 'controller Pod metadata');
    if (
      metadata.namespace !== config.controllerNamespace ||
      metadata.deletionTimestamp !== undefined ||
      Object.entries(deployment.matchLabels).some(
        ([key, expected]) => metadata.labels?.[key] !== expected
      )
    ) {
      fail('A selected controller Pod has the wrong identity.');
    }
    const admitted = inspectControllerPodSpec(pod.spec, config);
    if (admitted.serviceAccountName !== deployment.serviceAccountName) {
      fail('A controller Pod has the wrong admitted ServiceAccount.');
    }
    const status = object(pod.status, 'controller Pod status');
    if (
      status.phase !== 'Running' ||
      !conditionTrue(status.conditions, 'Ready')
    ) {
      fail('A controller Pod is not stably running and Ready.');
    }
    const statuses = array(
      status.containerStatuses,
      'controller container statuses'
    ).filter((entry) => entry?.name === config.controllerContainer);
    if (
      statuses.length !== 1 ||
      status.containerStatuses.length !== 1 ||
      statuses[0].image !== config.controllerImage ||
      typeof statuses[0].imageID !== 'string' ||
      !statuses[0].imageID.endsWith(config.controllerDigest) ||
      statuses[0].restartCount !== 0 ||
      statuses[0].ready !== true ||
      statuses[0].state?.running === undefined
    ) {
      fail('A controller Pod is not running the expected immutable image.');
    }
  }
  return { controllerPods: items.length };
}

export function buildKubernetesSecretProvenanceEvidence({
  config,
  controller,
  externalSecret,
  now = new Date(),
  store,
}) {
  const verifiedAt = dateOption(now, 'verification clock').toISOString();
  return {
    bindingSetSha256: externalSecret.bindingSetSha256,
    candidateCommit: config.candidateCommit,
    context: config.context,
    controllerDigest: config.controllerDigest,
    controllerPods: controller.controllerPods,
    controllerReferenceSha256: sha256(
      `${config.controllerNamespace}/${config.controllerDeployment}/${config.controllerContainer}`
    ),
    externalSecretGeneration: externalSecret.externalSecretGeneration,
    externalSecretReferenceSha256: externalSecret.externalSecretReferenceSha256,
    marker: KUBERNETES_SECRET_PROVENANCE_EVIDENCE_MARKER,
    namespace: config.namespace,
    refreshIntervalSeconds: externalSecret.refreshIntervalSeconds,
    refreshTime: externalSecret.refreshTime,
    secretKeyCount: externalSecret.secretKeyCount,
    secretKeySetSha256: externalSecret.secretKeySetSha256,
    secretReferenceSha256: externalSecret.secretReferenceSha256,
    secretStoreGeneration: store.secretStoreGeneration,
    secretStoreKind: config.storeKind,
    secretStoreSpecSha256: store.secretStoreSpecSha256,
    storeReferenceSha256: externalSecret.storeReferenceSha256,
    syncVersionSha256: externalSecret.syncVersionSha256,
    verifiedAt,
  };
}

export function kubernetesLabelSelector(labels) {
  return Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
}

function inspectSecretBindings(value, expectedKeys) {
  const entries = array(value, 'ExternalSecret data bindings');
  if (entries.length !== expectedKeys.length) {
    fail('The ExternalSecret has the wrong explicit key count.');
  }
  const bindings = [];
  for (const entry of entries) {
    const binding = exactObject(entry, 'ExternalSecret data binding', [
      'remoteRef',
      'secretKey',
    ]);
    if (
      typeof binding.secretKey !== 'string' ||
      !SECRET_KEY_PATTERN.test(binding.secretKey)
    ) {
      fail('The ExternalSecret has an invalid target key.');
    }
    const remote = allowedObject(
      binding.remoteRef,
      'ExternalSecret remoteRef',
      [
        'conversionStrategy',
        'decodingStrategy',
        'key',
        'metadataPolicy',
        'property',
        'version',
      ],
      ['key']
    );
    if (
      (remote.conversionStrategy !== undefined &&
        remote.conversionStrategy !== 'Default') ||
      (remote.decodingStrategy !== undefined &&
        remote.decodingStrategy !== 'None') ||
      (remote.metadataPolicy !== undefined && remote.metadataPolicy !== 'None')
    ) {
      fail('The ExternalSecret remoteRef transformation is not allowed.');
    }
    bindings.push({
      key: boundedString(remote.key, 'ExternalSecret remote key', 1_024),
      property: optionalBoundedString(
        remote.property,
        'ExternalSecret remote property',
        1_024
      ),
      secretKey: binding.secretKey,
      version: optionalBoundedString(
        remote.version,
        'ExternalSecret remote version',
        512
      ),
    });
  }
  bindings.sort((left, right) => left.secretKey.localeCompare(right.secretKey));
  if (
    !sameArray(
      bindings.map(({ secretKey }) => secretKey),
      expectedKeys
    )
  ) {
    fail('The ExternalSecret target keys do not match the declared set.');
  }
  return bindings;
}

function inspectControllerPodSpec(value, config) {
  const podSpec = object(value, 'controller pod spec');
  if (
    !podSpec.serviceAccountName ||
    podSpec.serviceAccountName === 'default' ||
    podSpec.hostNetwork === true ||
    podSpec.hostPID === true ||
    podSpec.hostIPC === true ||
    (Array.isArray(podSpec.initContainers) &&
      podSpec.initContainers.length > 0) ||
    (Array.isArray(podSpec.ephemeralContainers) &&
      podSpec.ephemeralContainers.length > 0) ||
    (Array.isArray(podSpec.volumes) &&
      podSpec.volumes.some((volume) => volume?.hostPath !== undefined))
  ) {
    fail('The controller pod identity or host isolation is unsafe.');
  }
  const containers = array(podSpec.containers, 'controller containers');
  const matches = containers.filter(
    (container) => container?.name === config.controllerContainer
  );
  if (containers.length !== 1 || matches.length !== 1) {
    fail('The controller Pod must have one declared container.');
  }
  const container = matches[0];
  const security = object(
    container.securityContext,
    'controller container security context'
  );
  if (
    container.image !== config.controllerImage ||
    security.allowPrivilegeEscalation !== false ||
    security.privileged !== false ||
    security.readOnlyRootFilesystem !== true ||
    security.runAsNonRoot !== true ||
    !sameArray(security.capabilities?.drop, ['ALL']) ||
    !['RuntimeDefault', undefined].includes(
      podSpec.securityContext?.seccompProfile?.type
    ) ||
    (podSpec.securityContext?.seccompProfile?.type === undefined &&
      security.seccompProfile?.type !== 'RuntimeDefault')
  ) {
    fail('The controller image or container security boundary is unsafe.');
  }
  return { serviceAccountName: podSpec.serviceAccountName };
}

function inspectNamespacedMetadata(value, expectedName, namespace, label) {
  const metadata = object(value, `${label} metadata`);
  if (
    metadata.name !== expectedName ||
    metadata.namespace !== namespace ||
    metadata.deletionTimestamp !== undefined ||
    !Number.isInteger(metadata.generation) ||
    metadata.generation < 1
  ) {
    fail(`The ${label} metadata does not match the declared resource.`);
  }
  return { generation: metadata.generation };
}

function readyCondition(value, label) {
  const matches = array(value, `${label} conditions`).filter(
    (condition) => condition?.type === 'Ready'
  );
  if (matches.length !== 1 || matches[0].status !== 'True') {
    fail(`The ${label} does not have one Ready=True condition.`);
  }
  return {
    lastTransitionTime: timestamp(
      matches[0].lastTransitionTime,
      `${label} Ready transition`
    ),
    reason: boundedString(matches[0].reason, `${label} Ready reason`, 128),
  };
}

function conditionTrue(value, type) {
  if (!Array.isArray(value)) return false;
  const matches = value.filter((condition) => condition?.type === type);
  return matches.length === 1 && matches[0].status === 'True';
}

function durationSeconds(value) {
  if (typeof value !== 'string' || value.length > 32) {
    fail('The ExternalSecret refreshInterval must be a bounded duration.');
  }
  const match =
    /^(?:(?<hours>0|[1-9]\d*)h)?(?:(?<minutes>0|[1-9]\d*)m)?(?:(?<seconds>0|[1-9]\d*)s)?$/u.exec(
      value
    );
  if (
    !match?.groups ||
    match[0].length === 0 ||
    (match.groups.hours === undefined &&
      match.groups.minutes === undefined &&
      match.groups.seconds === undefined)
  ) {
    fail('The ExternalSecret refreshInterval is not a whole-second duration.');
  }
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes ?? 0);
  const seconds = Number(match.groups.seconds ?? 0);
  if (
    minutes >= 60 ||
    seconds >= 60 ||
    (!Number.isSafeInteger(hours) && hours !== 0)
  ) {
    fail('The ExternalSecret refreshInterval is not canonical.');
  }
  const total = hours * 3_600 + minutes * 60 + seconds;
  if (!Number.isSafeInteger(total) || total < 60) {
    fail('The ExternalSecret refreshInterval is outside the supported range.');
  }
  return total;
}

function sortedSecretKeys(value) {
  if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) {
    fail('BYOK_GRID_EXTERNAL_SECRET_EXPECTED_KEYS is invalid.');
  }
  const keys = value.split(',');
  if (
    keys.length < 5 ||
    keys.length > 32 ||
    new Set(keys).size !== keys.length ||
    !sameArray([...keys].sort(), keys) ||
    keys.some((key) => !SECRET_KEY_PATTERN.test(key))
  ) {
    fail(
      'BYOK_GRID_EXTERNAL_SECRET_EXPECTED_KEYS must be a sorted unique production key set.'
    );
  }
  return keys;
}

function labelMap(value, label) {
  const labels = object(value, label);
  const entries = Object.entries(labels);
  if (
    entries.length === 0 ||
    entries.length > 16 ||
    entries.some(
      ([key, item]) =>
        !LABEL_KEY_PATTERN.test(key) ||
        typeof item !== 'string' ||
        !LABEL_VALUE_PATTERN.test(item)
    )
  ) {
    fail(`The ${label} are invalid.`);
  }
  return labels;
}

function kubernetesName(environment, name) {
  const value = required(environment, name);
  if (!DNS_LABEL_PATTERN.test(value)) {
    fail(`${name} must be a Kubernetes DNS label.`);
  }
  return value;
}

function boundedText(environment, name, maximum) {
  return boundedString(required(environment, name), name, maximum);
}

function required(environment, name) {
  const value = environment[name];
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${name} is required.`);
  }
  return value;
}

function boundedString(value, label, maximum) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`The ${label} is invalid.`);
  }
  return value;
}

function optionalBoundedString(value, label, maximum) {
  if (value === undefined) return '';
  return boundedString(value, label, maximum);
}

function boundedInteger(value, label, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) fail(`${label} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${label} is outside the supported range.`);
  }
  return parsed;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(`The ${label} is invalid.`);
  return value;
}

function timestamp(value, label) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    fail(`The ${label} must be a canonical UTC timestamp.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) fail(`The ${label} is invalid.`);
  return date;
}

function dateOption(value, label) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail(`The ${label} is invalid.`);
  }
  return value;
}

function exactObject(value, label, keys) {
  const result = object(value, label);
  if (!sameArray(Object.keys(result).sort(), [...keys].sort())) {
    fail(`The ${label} has an unexpected shape.`);
  }
  return result;
}

function allowedObject(value, label, allowedKeys, requiredKeys) {
  const result = object(value, label);
  const keys = Object.keys(result);
  if (
    keys.some((key) => !allowedKeys.includes(key)) ||
    requiredKeys.some((key) => !keys.includes(key))
  ) {
    fail(`The ${label} has an unexpected shape.`);
  }
  return result;
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`The ${label} must be an object.`);
  }
  return value;
}

function array(value, label) {
  if (!Array.isArray(value)) fail(`The ${label} must be an array.`);
  return value;
}

function emptyArray(value) {
  return Array.isArray(value) && value.length === 0;
}

function sameArray(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new KubernetesSecretProvenanceError(message);
}
