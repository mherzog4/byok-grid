import { createHash, randomUUID } from 'node:crypto';
import {
  parseProductionOrigin,
  verifyPublicDeployment,
} from './verify-public-deployment.mjs';

export const INGRESS_CLIENT_PROBE_MARKER =
  'BYOK_GRID_INGRESS_CLIENT_PROBE_VERIFIED';
export const RATE_LIMIT_LAYER_HEADER = 'x-byok-grid-rate-limit-layer';
export const INGRESS_PROBE_CONFIRMATION = 'controlled-production-candidate';

const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;
const NETWORK_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const APPLICATION_ATTEMPTS = 4;
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;

export function ingressClientProbeConfig(argv, environment) {
  if (argv.length !== 3) {
    throw new Error('Provide exactly one canonical HTTPS deployment origin.');
  }
  if (
    environment.BYOK_GRID_INGRESS_PROBE_CONFIRM !== INGRESS_PROBE_CONFIRMATION
  ) {
    throw new Error('The controlled ingress probe confirmation is required.');
  }
  const candidateCommit = environment.BYOK_GRID_CANDIDATE_COMMIT ?? '';
  if (!SHA_PATTERN.test(candidateCommit)) {
    throw new Error(
      'BYOK_GRID_CANDIDATE_COMMIT must be a lowercase commit SHA.'
    );
  }
  const networkId = environment.BYOK_GRID_INGRESS_NETWORK_ID ?? '';
  if (!NETWORK_ID_PATTERN.test(networkId)) {
    throw new Error(
      'BYOK_GRID_INGRESS_NETWORK_ID must be a bounded opaque label.'
    );
  }
  const challenge = environment.BYOK_GRID_INGRESS_PROBE_CHALLENGE ?? '';
  if (!CHALLENGE_PATTERN.test(challenge)) {
    throw new Error(
      'BYOK_GRID_INGRESS_PROBE_CHALLENGE must be a bounded shared challenge.'
    );
  }
  const edgeMaximumAttempts = integer(
    environment.BYOK_GRID_EDGE_RATE_LIMIT_MAX_ATTEMPTS,
    'BYOK_GRID_EDGE_RATE_LIMIT_MAX_ATTEMPTS',
    2,
    100
  );
  return {
    candidateCommit,
    challenge,
    edgeMaximumAttempts,
    networkId,
    origin: parseProductionOrigin(argv[2]),
  };
}

export async function runIngressClientProbe(options) {
  const origin = parseProductionOrigin(options.origin);
  if (!SHA_PATTERN.test(options.candidateCommit)) {
    throw new Error('The ingress probe candidate commit is invalid.');
  }
  if (!NETWORK_ID_PATTERN.test(options.networkId)) {
    throw new Error('The ingress probe network identity is invalid.');
  }
  if (!CHALLENGE_PATTERN.test(options.challenge)) {
    throw new Error('The ingress probe challenge is invalid.');
  }
  if (
    !Number.isSafeInteger(options.edgeMaximumAttempts) ||
    options.edgeMaximumAttempts < 2 ||
    options.edgeMaximumAttempts > 100
  ) {
    throw new Error('The edge rate-limit probe must allow 2 to 100 attempts.');
  }
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
  if (
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 60_000
  ) {
    throw new Error(
      'The ingress probe timeout must be between 1 and 60 seconds.'
    );
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;
  const now = options.now ?? (() => new Date());
  const publicDeployment = await (
    options.verifyPublicDeploymentImplementation ?? verifyPublicDeployment
  )({ origin, fetchImplementation, timeoutMilliseconds });
  if (publicDeployment.marker !== 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED') {
    throw new Error(
      'The canonical public deployment verification did not pass.'
    );
  }

  const applicationRateLimit = await probeApplicationRateLimit({
    fetchImplementation,
    origin,
    probeId: options.randomUUIDImplementation?.() ?? randomUUID(),
    timeoutMilliseconds,
    now,
  });
  const edgeRateLimit = await probeEdgeRateLimit({
    fetchImplementation,
    maximumAttempts: options.edgeMaximumAttempts,
    origin,
    timeoutMilliseconds,
    now,
  });
  const verifiedAt = now();
  if (!(verifiedAt instanceof Date) || Number.isNaN(verifiedAt.valueOf())) {
    throw new Error('The ingress probe clock returned an invalid date.');
  }

  return verifyIngressClientProbeRecord({
    candidateCommit: options.candidateCommit,
    challengeSha256: sha256(options.challenge),
    checks: {
      applicationRateLimit,
      edgeRateLimit,
      publicDeployment: {
        marker: publicDeployment.marker,
        requests: publicDeployment.requests,
      },
    },
    marker: INGRESS_CLIENT_PROBE_MARKER,
    networkIdSha256: sha256(options.networkId),
    origin,
    verifiedAt: verifiedAt.toISOString(),
  });
}

export function verifyIngressClientProbeRecord(value) {
  const root = exactObject(value, 'ingress client probe', [
    'candidateCommit',
    'challengeSha256',
    'checks',
    'marker',
    'networkIdSha256',
    'origin',
    'verifiedAt',
  ]);
  if (!SHA_PATTERN.test(root.candidateCommit))
    fail('The client probe commit is invalid.');
  if (!SHA256_PATTERN.test(root.challengeSha256))
    fail('The client probe challenge digest is invalid.');
  if (root.marker !== INGRESS_CLIENT_PROBE_MARKER)
    fail('The client probe marker is invalid.');
  if (!SHA256_PATTERN.test(root.networkIdSha256))
    fail('The client network digest is invalid.');
  const origin = parseProductionOrigin(root.origin);
  const verifiedAt = timestamp(root.verifiedAt, 'client probe timestamp');

  const checks = exactObject(root.checks, 'client probe checks', [
    'applicationRateLimit',
    'edgeRateLimit',
    'publicDeployment',
  ]);
  const application = rateLimitResult(
    checks.applicationRateLimit,
    'application',
    APPLICATION_ATTEMPTS
  );
  const edge = rateLimitResult(checks.edgeRateLimit, 'edge', 100);
  const applicationObservedAt = timestamp(
    application.observedAt,
    'application rate-limit timestamp'
  );
  const edgeObservedAt = timestamp(
    edge.observedAt,
    'edge rate-limit timestamp'
  );
  if (applicationObservedAt > edgeObservedAt || edgeObservedAt > verifiedAt) {
    fail('The ingress client probe timestamps are out of execution order.');
  }
  const publicDeployment = exactObject(
    checks.publicDeployment,
    'public deployment check',
    ['marker', 'requests']
  );
  if (
    publicDeployment.marker !== 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED' ||
    publicDeployment.requests !== 4
  ) {
    fail('The client probe lacks the exact public deployment check.');
  }

  return {
    candidateCommit: root.candidateCommit,
    challengeSha256: root.challengeSha256,
    checks: {
      applicationRateLimit: application,
      edgeRateLimit: edge,
      publicDeployment: {
        marker: publicDeployment.marker,
        requests: publicDeployment.requests,
      },
    },
    marker: root.marker,
    networkIdSha256: root.networkIdSha256,
    origin,
    verifiedAt: root.verifiedAt,
  };
}

async function probeApplicationRateLimit(options) {
  if (!UUID_PATTERN.test(options.probeId)) {
    fail('The application rate-limit probe identity is invalid.');
  }
  let acceptedResponses = 0;
  for (let attempt = 1; attempt <= APPLICATION_ATTEMPTS; attempt += 1) {
    const response = await boundedFetch(
      options.fetchImplementation,
      new URL('/api/auth/sign-in/email', options.origin),
      {
        body: JSON.stringify({
          email: `ingress-probe-${options.probeId}@invalid.example`,
          password: 'ingress-probe-password-not-an-account',
        }),
        headers: {
          accept: 'application/json',
          'cache-control': 'no-cache',
          'content-type': 'application/json',
          origin: options.origin,
          'user-agent': 'byok-grid-ingress-client-probe/1',
        },
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMilliseconds),
      },
      'The application rate-limit endpoint could not be reached.'
    );
    try {
      if (attempt < APPLICATION_ATTEMPTS) {
        if (
          response.status !== 401 ||
          response.headers.has(RATE_LIMIT_LAYER_HEADER)
        ) {
          fail('The application rate-limit baseline response was unexpected.');
        }
        acceptedResponses += 1;
        continue;
      }
      return limitedResult(response, {
        acceptedResponses,
        attempts: attempt,
        layer: 'application',
        observedAt: observedAt(options.now, 'application probe clock'),
        retryHeader: 'x-retry-after',
      });
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }
  fail('The application rate limit was not observed.');
}

async function probeEdgeRateLimit(options) {
  let acceptedResponses = 0;
  for (let attempt = 1; attempt <= options.maximumAttempts; attempt += 1) {
    const response = await boundedFetch(
      options.fetchImplementation,
      new URL('/sign-in', options.origin),
      {
        headers: {
          accept: 'text/html',
          'cache-control': 'no-cache',
          'user-agent': 'byok-grid-ingress-client-probe/1',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(options.timeoutMilliseconds),
      },
      'The edge rate-limit endpoint could not be reached.'
    );
    try {
      if (response.status === 200) {
        if (response.headers.has(RATE_LIMIT_LAYER_HEADER)) {
          fail('The edge rate-limit baseline response was unexpected.');
        }
        acceptedResponses += 1;
        continue;
      }
      if (response.status === 429) {
        if (acceptedResponses === 0) {
          fail(
            'The edge probe did not observe an allowed request before limiting.'
          );
        }
        return limitedResult(response, {
          acceptedResponses,
          attempts: attempt,
          layer: 'edge',
          observedAt: observedAt(options.now, 'edge probe clock'),
          retryHeader: 'retry-after',
        });
      }
      fail('The edge rate-limit response was unexpected.');
    } finally {
      await response.body?.cancel().catch(() => undefined);
    }
  }
  fail('The edge rate limit was not observed within the configured ceiling.');
}

function limitedResult(response, options) {
  if (
    response.status !== 429 ||
    response.headers.get(RATE_LIMIT_LAYER_HEADER) !== options.layer
  ) {
    fail(`The ${options.layer} rate-limit response lacked layer provenance.`);
  }
  const retryAfterSeconds = integer(
    response.headers.get(options.retryHeader),
    `${options.layer} retry interval`,
    1,
    options.layer === 'application' ? 10 : 86_400
  );
  return {
    acceptedResponses: options.acceptedResponses,
    attempts: options.attempts,
    limitedStatus: 429,
    observedAt: options.observedAt,
    retryAfterSeconds,
  };
}

function rateLimitResult(value, layer, maximumAttempts) {
  const result = exactObject(value, `${layer} rate-limit result`, [
    'acceptedResponses',
    'attempts',
    'limitedStatus',
    'observedAt',
    'retryAfterSeconds',
  ]);
  if (
    !Number.isSafeInteger(result.acceptedResponses) ||
    result.acceptedResponses < 1 ||
    !Number.isSafeInteger(result.attempts) ||
    result.attempts !== result.acceptedResponses + 1 ||
    result.attempts > maximumAttempts ||
    result.limitedStatus !== 429 ||
    typeof result.observedAt !== 'string' ||
    !Number.isSafeInteger(result.retryAfterSeconds) ||
    result.retryAfterSeconds < 1 ||
    result.retryAfterSeconds > (layer === 'application' ? 10 : 86_400) ||
    (layer === 'application' &&
      (result.acceptedResponses !== 3 ||
        result.attempts !== APPLICATION_ATTEMPTS))
  ) {
    fail(`The ${layer} rate-limit result is invalid.`);
  }
  timestamp(result.observedAt, `${layer} rate-limit timestamp`);
  return {
    acceptedResponses: result.acceptedResponses,
    attempts: result.attempts,
    limitedStatus: result.limitedStatus,
    observedAt: result.observedAt,
    retryAfterSeconds: result.retryAfterSeconds,
  };
}

async function boundedFetch(fetchImplementation, url, init, message) {
  try {
    const response = await fetchImplementation(url, init);
    if (!(response instanceof Response))
      fail('The ingress probe transport returned an invalid response.');
    if (response.status >= 300 && response.status < 400)
      fail('The ingress probe unexpectedly redirected.');
    return response;
  } catch (error) {
    throw new Error(message, { cause: error });
  }
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

function integer(value, name, minimum, maximum) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    fail(`${name} must be an integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    fail(`${name} is outside its allowed range.`);
  }
  return parsed;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value))
    fail(`The ${name} is invalid.`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value)
    fail(`The ${name} is invalid.`);
  return parsed;
}

function observedAt(now, name) {
  const value = now();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    fail(`The ${name} returned an invalid date.`);
  }
  return value.toISOString();
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fail(message) {
  throw new Error(message);
}
