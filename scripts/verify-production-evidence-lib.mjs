import { lstatSync, readFileSync } from 'node:fs';

export const PRODUCTION_EVIDENCE_MARKER =
  'BYOK_GRID_PRODUCTION_EVIDENCE_VERIFIED';

export const REQUIRED_PRODUCTION_EVIDENCE_IDS = Object.freeze([
  'authenticated-worker-drain',
  'candidate-source-equivalence',
  'code-security',
  'multi-architecture-smoke',
  'observation-window',
  'production-capacity',
  'public-ingress-and-proxy',
  'reference-deployment',
  'release-assets',
  'release-tag-protection',
  'remote-libsql-recovery',
  'smtp-delivery',
]);

export const OPTIONAL_PRODUCTION_ADAPTERS = Object.freeze([
  'airbyte',
  'clickhouse',
]);

const OPTIONAL_ADAPTER_EVIDENCE = Object.freeze({
  airbyte: 'airbyte-e2e',
  clickhouse: 'clickhouse-e2e',
});

const EXPECTED_MARKERS = Object.freeze({
  'authenticated-worker-drain': ['BYOK_GRID_KUBERNETES_WORKER_DRAIN_VERIFIED'],
  'multi-architecture-smoke': ['BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED'],
  'production-capacity': ['BYOK_GRID_PRODUCTION_CAPACITY_VERIFIED'],
  'public-ingress-and-proxy': [
    'BYOK_GRID_INGRESS_BOUNDARY_VERIFIED',
    'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
  ],
  'reference-deployment': [
    'BYOK_GRID_KUBERNETES_EXTERNAL_SECRET_PROVENANCE_VERIFIED',
    'BYOK_GRID_KUBERNETES_NETWORK_POLICY_ENFORCEMENT_VERIFIED',
    'BYOK_GRID_KUBERNETES_RUNTIME_VERIFIED',
  ],
  'release-assets': [
    'BYOK_GRID_PUBLISHED_RELEASE_VERIFIED',
    'BYOK_GRID_RELEASE_BUNDLE_VERIFIED',
  ],
  'remote-libsql-recovery': [
    'BYOK_GRID_REMOTE_LIBSQL_DRILL_PREPARED',
    'BYOK_GRID_REMOTE_LIBSQL_RESTORE_VERIFIED',
  ],
  'smtp-delivery': ['BYOK_GRID_SMTP_DELIVERY_AUTHENTICATION_VERIFIED'],
});

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const PRERELEASE_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)$/u;
const OPERATOR_PATTERN = /^github:[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/u;
const MAX_EVIDENCE_BYTES = 131_072;
const MINIMUM_OBSERVATION_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export class ProductionEvidenceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ProductionEvidenceError';
  }
}

export function verifyProductionEvidence(value, options = {}) {
  const root = exactObject(value, 'production evidence manifest', [
    'acceptance',
    'candidate',
    'evidence',
    'observationWindow',
    'releaseVersion',
    'rollback',
    'schemaVersion',
    'supportedOptionalAdapters',
  ]);
  if (root.schemaVersion !== 1) {
    fail('The production evidence schemaVersion must be 1.');
  }

  const releaseVersion = stableVersion(root.releaseVersion, 'releaseVersion');
  if (
    options.expectedReleaseVersion !== undefined &&
    releaseVersion !== options.expectedReleaseVersion
  ) {
    fail('The production evidence releaseVersion does not match the release.');
  }
  const candidate = exactObject(root.candidate, 'candidate', [
    'commit',
    'digestManifestSha256',
    'version',
  ]);
  const candidateCommit = sha(candidate.commit, 'candidate.commit');
  if (
    options.expectedCandidateCommit !== undefined &&
    candidateCommit !== options.expectedCandidateCommit
  ) {
    fail('The production evidence candidate commit does not match.');
  }
  const candidateVersion = prereleaseVersion(
    candidate.version,
    'candidate.version'
  );
  if (candidateVersion.split('-', 1)[0] !== releaseVersion) {
    fail('The candidate version must promote the same stable version.');
  }
  sha(candidate.commit, 'candidate.commit');
  sha256(candidate.digestManifestSha256, 'candidate.digestManifestSha256');

  const now = dateOption(options.now ?? new Date(), 'verification clock');
  const observation = exactObject(root.observationWindow, 'observationWindow', [
    'endedAt',
    'startedAt',
    'unresolvedBlockers',
  ]);
  const observationStartedAt = timestamp(
    observation.startedAt,
    'observationWindow.startedAt'
  );
  const observationEndedAt = timestamp(
    observation.endedAt,
    'observationWindow.endedAt'
  );
  if (
    observationEndedAt.getTime() - observationStartedAt.getTime() <
    MINIMUM_OBSERVATION_MS
  ) {
    fail('The candidate observation window must be at least 24 hours.');
  }
  if (observation.unresolvedBlockers !== 0) {
    fail(
      'The candidate observation window must have zero unresolved blockers.'
    );
  }
  notFuture(observationEndedAt, now, 'observationWindow.endedAt');

  const rollback = exactObject(root.rollback, 'rollback', [
    'artifactSha256',
    'markers',
    'reference',
    'testedAt',
  ]);
  const rollbackTestedAt = timestamp(rollback.testedAt, 'rollback.testedAt');
  sha256(rollback.artifactSha256, 'rollback.artifactSha256');
  if (
    !sameArray(stringArray(rollback.markers, 'rollback.markers'), [
      'BYOK_GRID_KUBERNETES_ROLLBACK_VERIFIED',
    ])
  ) {
    fail('Rollback evidence must carry the exact Kubernetes rollback marker.');
  }
  httpsReference(rollback.reference, 'rollback.reference');
  if (
    rollbackTestedAt < observationStartedAt ||
    rollbackTestedAt > observationEndedAt
  ) {
    fail('Rollback evidence must be tested during the candidate window.');
  }
  notFuture(rollbackTestedAt, now, 'rollback.testedAt');

  const acceptance = exactObject(root.acceptance, 'acceptance', [
    'acceptedAt',
    'operatorId',
    'reference',
  ]);
  if (
    typeof acceptance.operatorId !== 'string' ||
    !OPERATOR_PATTERN.test(acceptance.operatorId)
  ) {
    fail('acceptance.operatorId must be a canonical lowercase github: login.');
  }
  const acceptedAt = timestamp(acceptance.acceptedAt, 'acceptance.acceptedAt');
  httpsReference(acceptance.reference, 'acceptance.reference');
  if (acceptedAt < observationEndedAt || acceptedAt < rollbackTestedAt) {
    fail('Operator acceptance must follow observation and rollback evidence.');
  }
  notFuture(acceptedAt, now, 'acceptance.acceptedAt');

  const supportedOptionalAdapters = stringArray(
    root.supportedOptionalAdapters,
    'supportedOptionalAdapters'
  );
  if (
    supportedOptionalAdapters.some(
      (adapter) => !OPTIONAL_PRODUCTION_ADAPTERS.includes(adapter)
    ) ||
    new Set(supportedOptionalAdapters).size !==
      supportedOptionalAdapters.length ||
    !isSorted(supportedOptionalAdapters)
  ) {
    fail(
      'supportedOptionalAdapters must be a sorted unique list of supported adapter IDs.'
    );
  }

  if (!Array.isArray(root.evidence)) {
    fail('The production evidence manifest needs an evidence array.');
  }
  const expectedIds = [
    ...REQUIRED_PRODUCTION_EVIDENCE_IDS,
    ...supportedOptionalAdapters.map(
      (adapter) => OPTIONAL_ADAPTER_EVIDENCE[adapter]
    ),
  ].sort();
  if (root.evidence.length !== expectedIds.length) {
    fail('The production evidence manifest has an incomplete gate set.');
  }

  const evidenceIds = [];
  for (const rawRecord of root.evidence) {
    const record = exactObject(rawRecord, 'evidence record', [
      'artifactSha256',
      'id',
      'markers',
      'reference',
      'verifiedAt',
    ]);
    if (typeof record.id !== 'string') {
      fail('Every production evidence record needs a recognized id.');
    }
    evidenceIds.push(record.id);
    sha256(record.artifactSha256, 'evidence.artifactSha256');
    httpsReference(record.reference, 'evidence.reference');
    const verifiedAt = timestamp(record.verifiedAt, 'evidence.verifiedAt');
    if (verifiedAt > acceptedAt) {
      fail('Evidence cannot be verified after operator acceptance.');
    }
    notFuture(verifiedAt, now, 'evidence.verifiedAt');
    const markers = stringArray(record.markers, 'evidence.markers');
    const expectedMarkers = EXPECTED_MARKERS[record.id] ?? [];
    if (!sameArray(markers, expectedMarkers)) {
      fail('A production evidence record has incorrect structured markers.');
    }
    if (record.id === 'observation-window' && verifiedAt < observationEndedAt) {
      fail(
        'Observation-window evidence must be verified after the window ends.'
      );
    }
  }
  evidenceIds.sort();
  if (!sameArray(evidenceIds, expectedIds)) {
    fail('The production evidence manifest has missing or duplicate gate IDs.');
  }

  return {
    candidateCommit,
    candidateVersion,
    evidenceCount: expectedIds.length,
    observationHours:
      (observationEndedAt.getTime() - observationStartedAt.getTime()) /
      (60 * 60 * 1_000),
    operatorId: acceptance.operatorId,
    releaseVersion,
    supportedOptionalAdapters,
  };
}

export function assertStablePromotionPaths(paths, releaseVersion) {
  stableVersion(releaseVersion, 'releaseVersion');
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.some(
      (path) =>
        typeof path !== 'string' ||
        !path ||
        path.startsWith('/') ||
        path.includes('..') ||
        /[\0\r\n]/u.test(path)
    )
  ) {
    fail('Stable promotion needs a bounded candidate-to-release path list.');
  }
  const evidencePath = `docs/evidence/${releaseVersion}-production.json`;
  const allowed = new Set([
    'SECURITY.md',
    'deploy/helm/byok-grid/Chart.yaml',
    'docs/PRODUCTION_READINESS.md',
    evidencePath,
    'package-lock.json',
    'package.json',
  ]);
  if (!paths.includes(evidencePath)) {
    fail('Stable promotion must add its versioned production evidence file.');
  }
  if (new Set(paths).size !== paths.length) {
    fail('Stable promotion paths must be unique.');
  }
  if (paths.some((path) => !allowed.has(path))) {
    fail('Stable promotion changed files outside the release-only allowlist.');
  }
  if (paths.length !== allowed.size) {
    fail('Stable promotion must change the exact release-only file set.');
  }
}

export function verifyProductionEvidenceFile(path, options = {}) {
  let source;
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      fail('The production evidence path must be a regular file.');
    }
    if (metadata.size > MAX_EVIDENCE_BYTES) {
      fail('The production evidence file exceeds 128 KiB.');
    }
    source = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ProductionEvidenceError) throw error;
    throw new ProductionEvidenceError(
      'The production evidence file could not be read.',
      { cause: error }
    );
  }

  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new ProductionEvidenceError(
      'The production evidence file must contain valid JSON.',
      { cause: error }
    );
  }
  return verifyProductionEvidence(value, options);
}

function exactObject(value, name, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`The ${name} must be an object.`);
  }
  const keys = Object.keys(value).sort();
  if (!sameArray(keys, [...expectedKeys].sort())) {
    fail(`The ${name} contains missing or unexpected fields.`);
  }
  return value;
}

function stableVersion(value, name) {
  if (typeof value !== 'string' || !STABLE_VERSION_PATTERN.test(value)) {
    fail(`${name} must be a canonical stable semantic version.`);
  }
  return value;
}

function prereleaseVersion(value, name) {
  if (typeof value !== 'string' || !PRERELEASE_VERSION_PATTERN.test(value)) {
    fail(`${name} must be a canonical prerelease semantic version.`);
  }
  return value;
}

function sha(value, name) {
  if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
    fail(`${name} must be a lowercase 40-character commit SHA.`);
  }
  return value;
}

function sha256(value, name) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`${name} must be a lowercase SHA-256 digest without a prefix.`);
  }
  return value;
}

function timestamp(value, name) {
  if (typeof value !== 'string') {
    fail(`${name} must be a canonical UTC timestamp.`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail(`${name} must be a canonical UTC timestamp.`);
  }
  return parsed;
}

function dateOption(value, name) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(`The ${name} must be a valid Date.`);
  }
  return value;
}

function notFuture(value, now, name) {
  if (value.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    fail(`${name} cannot be in the future.`);
  }
}

function httpsReference(value, name) {
  if (typeof value !== 'string' || value.length > 2_048) {
    fail(`${name} must be a bounded canonical HTTPS URL.`);
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${name} must be a bounded canonical HTTPS URL.`);
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname === '/' ||
    localHostname(parsed.hostname) ||
    parsed.href !== value
  ) {
    fail(`${name} must be a bounded canonical HTTPS URL.`);
  }
  return value;
}

function localHostname(hostname) {
  const value = hostname.toLowerCase();
  return (
    value === 'localhost' ||
    value.endsWith('.localhost') ||
    value === '0.0.0.0' ||
    value.startsWith('127.') ||
    value === '[::]' ||
    value === '[::1]'
  );
}

function stringArray(value, name) {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== 'string')
  ) {
    fail(`${name} must be an array of strings.`);
  }
  return value;
}

function isSorted(values) {
  return values.every(
    (value, index) => index === 0 || values[index - 1].localeCompare(value) < 0
  );
}

function sameArray(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function fail(message) {
  throw new ProductionEvidenceError(message);
}
