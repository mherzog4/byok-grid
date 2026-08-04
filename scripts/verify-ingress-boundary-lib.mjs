import { lstatSync, readFileSync } from 'node:fs';
import { parseProductionOrigin } from './verify-public-deployment.mjs';
import { verifyIngressClientProbeRecord } from './drill-ingress-client-lib.mjs';

export const INGRESS_BOUNDARY_EVIDENCE_MARKER =
  'BYOK_GRID_INGRESS_BOUNDARY_VERIFIED';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAXIMUM_EVIDENCE_BYTES = 131_072;
const MAXIMUM_PROBE_SPAN_MS = 24 * 60 * 60 * 1_000;
const MAXIMUM_APPLICATION_PROBE_SKEW_MS = 5_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;

export function verifyIngressBoundaryEvidence(value, options = {}) {
  const root = exactObject(value, 'ingress boundary evidence', [
    'candidateCommit',
    'clientProbes',
    'origin',
    'proxyBoundary',
    'schemaVersion',
  ]);
  if (root.schemaVersion !== 1)
    fail('The ingress evidence schemaVersion must be 1.');
  if (!SHA_PATTERN.test(root.candidateCommit))
    fail('The ingress evidence commit is invalid.');
  if (
    options.expectedCandidateCommit !== undefined &&
    root.candidateCommit !== options.expectedCandidateCommit
  ) {
    fail('The ingress evidence commit does not match the expected candidate.');
  }
  const origin = parseProductionOrigin(root.origin);
  const now = validDate(options.now ?? new Date(), 'verification clock');

  if (!Array.isArray(root.clientProbes) || root.clientProbes.length !== 2) {
    fail('Ingress evidence requires exactly two external client probes.');
  }
  const clientProbes = root.clientProbes.map((probe) =>
    verifyIngressClientProbeRecord(probe)
  );
  if (new Set(clientProbes.map((probe) => probe.networkIdSha256)).size !== 2) {
    fail(
      'Ingress client probes must come from two distinct network identities.'
    );
  }
  if (clientProbes[0].networkIdSha256 >= clientProbes[1].networkIdSha256) {
    fail('Ingress client probes must be sorted by network identity digest.');
  }
  if (new Set(clientProbes.map((probe) => probe.challengeSha256)).size !== 1) {
    fail('Ingress client probes must use the same shared challenge.');
  }
  for (const probe of clientProbes) {
    if (
      probe.candidateCommit !== root.candidateCommit ||
      probe.origin !== origin
    ) {
      fail('Every ingress client probe must match the candidate and origin.');
    }
  }

  const proxy = exactObject(root.proxyBoundary, 'proxy boundary evidence', [
    'artifactSha256',
    'directAccessDenied',
    'forwardedForMode',
    'observedChainSha256',
    'reference',
    'trustedProxyCidrsSha256',
    'verifiedAt',
  ]);
  sha256(proxy.artifactSha256, 'proxy artifact digest');
  sha256(proxy.observedChainSha256, 'observed proxy-chain digest');
  sha256(proxy.trustedProxyCidrsSha256, 'trusted-proxy configuration digest');
  if (proxy.directAccessDenied !== true) {
    fail('Proxy boundary evidence must prove direct web access denial.');
  }
  if (!['append', 'overwrite'].includes(proxy.forwardedForMode)) {
    fail('Proxy forwarding mode must be append or overwrite.');
  }
  httpsReference(proxy.reference, 'proxy evidence reference');
  const proxyVerifiedAt = timestamp(
    proxy.verifiedAt,
    'proxy verification timestamp'
  );

  const evidenceTimes = [
    proxyVerifiedAt,
    ...clientProbes.flatMap((probe) => [
      timestamp(probe.verifiedAt, 'client probe timestamp'),
      timestamp(
        probe.checks.applicationRateLimit.observedAt,
        'application rate-limit timestamp'
      ),
      timestamp(
        probe.checks.edgeRateLimit.observedAt,
        'edge rate-limit timestamp'
      ),
    ]),
  ];
  for (const evidenceTime of evidenceTimes) {
    if (evidenceTime.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      fail('Ingress evidence cannot be verified in the future.');
    }
  }
  const milliseconds = evidenceTimes.map((date) => date.getTime());
  if (
    Math.max(...milliseconds) - Math.min(...milliseconds) >
    MAXIMUM_PROBE_SPAN_MS
  ) {
    fail(
      'Ingress boundary evidence must be collected within one 24-hour window.'
    );
  }
  const applicationTimes = clientProbes.map((probe) =>
    timestamp(
      probe.checks.applicationRateLimit.observedAt,
      'application rate-limit timestamp'
    ).getTime()
  );
  if (
    Math.max(...applicationTimes) - Math.min(...applicationTimes) >
    MAXIMUM_APPLICATION_PROBE_SKEW_MS
  ) {
    fail(
      'Application rate-limit probes must overlap the same five-second window.'
    );
  }

  return {
    candidateCommit: root.candidateCommit,
    challengeSha256: clientProbes[0].challengeSha256,
    clientNetworks: 2,
    marker: INGRESS_BOUNDARY_EVIDENCE_MARKER,
    origin,
    proxyForwardingMode: proxy.forwardedForMode,
    verifiedAt: now.toISOString(),
  };
}

export function verifyIngressBoundaryEvidenceFile(path, options = {}) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new Error('The ingress evidence file could not be inspected.', {
      cause: error,
    });
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail('The ingress evidence input must be a regular file.');
  }
  if (metadata.size < 2 || metadata.size > MAXIMUM_EVIDENCE_BYTES) {
    fail('The ingress evidence file is outside the allowed size boundary.');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error('The ingress evidence file is not valid JSON.', {
      cause: error,
    });
  }
  return verifyIngressBoundaryEvidence(parsed, options);
}

function exactObject(value, name, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`The ${name} is malformed.`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`The ${name} has missing or unexpected fields.`);
  }
  return value;
}

function sha256(value, name) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    fail(`The ${name} is invalid.`);
  }
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value))
    fail(`The ${name} is invalid.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value)
    fail(`The ${name} is invalid.`);
  return parsed;
}

function validDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf()))
    fail(`The ${name} is invalid.`);
  return value;
}

function httpsReference(value, name) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`The ${name} must be a credential-free HTTPS URL.`);
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(
      `The ${name} must be a credential-free HTTPS URL without query or fragment.`
    );
  }
}

function fail(message) {
  throw new Error(message);
}
