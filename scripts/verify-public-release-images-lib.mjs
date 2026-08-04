export const PUBLIC_RELEASE_IMAGES_MARKER =
  'BYOK_GRID_PUBLIC_RELEASE_IMAGES_VERIFIED';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_PATTERN = /^byok-grid-[a-z0-9-]+$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/u;

export class PublicReleaseImagesError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PublicReleaseImagesError';
  }
}

export async function verifyPublicReleaseImages({ records, inspectPublicTag }) {
  if (!Array.isArray(records) || records.length !== 7) {
    fail(
      'Public release verification requires the exact seven-image inventory.'
    );
  }
  if (typeof inspectPublicTag !== 'function') {
    fail('An anonymous GHCR inspector is required.');
  }

  const destinations = new Set();
  const version = records[0]?.version;
  for (const record of records) {
    validateRecord(record);
    if (record.version !== version || destinations.has(record.destination)) {
      fail('Public release image records must be unique and version-bound.');
    }
    destinations.add(record.destination);

    let state;
    try {
      state = await inspectPublicTag(record);
    } catch (error) {
      if (error instanceof PublicReleaseImagesError) throw error;
      throw new PublicReleaseImagesError(
        'A public release image could not be inspected anonymously.',
        { cause: error }
      );
    }
    if (
      state?.status !== 'present' ||
      state.digest !== record.digest ||
      Object.keys(state).sort(compareAscii).join(',') !== 'digest,status'
    ) {
      fail('A release image is not anonymously readable at its exact digest.');
    }
  }

  return {
    anonymous: true,
    images: records.length,
    marker: PUBLIC_RELEASE_IMAGES_MARKER,
    version,
  };
}

export function createAnonymousGhcrTagInspector({
  fetchImplementation = globalThis.fetch,
  timeoutMilliseconds = 15_000,
} = {}) {
  if (
    typeof fetchImplementation !== 'function' ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 60_000
  ) {
    fail('The anonymous GHCR inspector configuration is invalid.');
  }

  const bearerTokens = new Map();
  return async (record) => {
    validateRecord(record);
    const repositoryPath = record.repository.slice('ghcr.io/'.length);
    let bearerToken = bearerTokens.get(record.repository);
    if (!bearerToken) {
      bearerToken = await requestAnonymousBearerToken({
        fetchImplementation,
        repositoryPath,
        timeoutMilliseconds,
      });
      bearerTokens.set(record.repository, bearerToken);
    }

    const [tagDigest, immutableDigest] = await Promise.all([
      inspectManifest({
        bearerToken,
        expectedDigest: record.digest,
        fetchImplementation,
        reference: record.version,
        repositoryPath,
        timeoutMilliseconds,
      }),
      inspectManifest({
        bearerToken,
        expectedDigest: record.digest,
        fetchImplementation,
        reference: record.digest,
        repositoryPath,
        timeoutMilliseconds,
      }),
    ]);
    if (tagDigest !== immutableDigest) {
      fail('The anonymous GHCR tag and digest identities do not match.');
    }
    return { digest: tagDigest, status: 'present' };
  };
}

async function requestAnonymousBearerToken({
  fetchImplementation,
  repositoryPath,
  timeoutMilliseconds,
}) {
  const endpoint = new URL('https://ghcr.io/token');
  endpoint.searchParams.set('service', 'ghcr.io');
  endpoint.searchParams.set('scope', `repository:${repositoryPath}:pull`);

  let response;
  try {
    response = await fetchImplementation(endpoint, {
      headers: { accept: 'application/json' },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch (error) {
    throw new PublicReleaseImagesError(
      'Anonymous GHCR authorization could not be established.',
      { cause: error }
    );
  }
  if (response.status !== 200) {
    fail('Anonymous GHCR authorization returned an unexpected status.');
  }

  const source = await readBoundedText(response, 32_768);
  let body;
  try {
    body = JSON.parse(source);
  } catch (error) {
    throw new PublicReleaseImagesError(
      'Anonymous GHCR authorization returned an invalid response.',
      { cause: error }
    );
  }
  const bearerToken = body?.token ?? body?.access_token;
  if (
    typeof bearerToken !== 'string' ||
    bearerToken.length === 0 ||
    bearerToken.length > 16_384
  ) {
    fail('Anonymous GHCR authorization returned an invalid response.');
  }
  return bearerToken;
}

async function inspectManifest({
  bearerToken,
  expectedDigest,
  fetchImplementation,
  reference,
  repositoryPath,
  timeoutMilliseconds,
}) {
  let response;
  try {
    response = await fetchImplementation(
      `https://ghcr.io/v2/${repositoryPath}/manifests/${encodeURIComponent(reference)}`,
      {
        headers: {
          accept: [
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json',
          ].join(', '),
          authorization: `Bearer ${bearerToken}`,
        },
        method: 'HEAD',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMilliseconds),
      }
    );
  } catch (error) {
    throw new PublicReleaseImagesError(
      'A release image could not be read anonymously from GHCR.',
      { cause: error }
    );
  }
  if (response.status !== 200) {
    fail('A release image is not anonymously readable from GHCR.');
  }
  const digest = response.headers.get('docker-content-digest');
  if (!DIGEST_PATTERN.test(digest ?? '') || digest !== expectedDigest) {
    fail('An anonymous GHCR response returned the wrong immutable digest.');
  }
  return digest;
}

async function readBoundedText(response, maximumBytes) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('Anonymous GHCR authorization returned an unreadable response.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytes = 0;
  let source = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        fail('Anonymous GHCR authorization exceeded the size limit.');
      }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
  } catch (error) {
    if (error instanceof PublicReleaseImagesError) throw error;
    throw new PublicReleaseImagesError(
      'Anonymous GHCR authorization returned an unreadable response.',
      { cause: error }
    );
  } finally {
    reader.releaseLock();
  }
  return source;
}

function validateRecord(record) {
  const repositoryMatch =
    typeof record?.repository === 'string'
      ? record.repository.match(
          /^ghcr\.io\/(?<owner>[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?)\/(?<image>byok-grid-[a-z0-9-]+)$/u
        )
      : undefined;
  if (
    !record ||
    typeof record !== 'object' ||
    Array.isArray(record) ||
    !IMAGE_PATTERN.test(record.image ?? '') ||
    !DIGEST_PATTERN.test(record.digest ?? '') ||
    !SEMVER_PATTERN.test(record.version ?? '') ||
    !repositoryMatch?.groups ||
    repositoryMatch.groups.owner.includes('--') ||
    repositoryMatch.groups.image !== record.image ||
    record.source !== `${record.repository}@${record.digest}` ||
    record.destination !== `${record.repository}:${record.version}`
  ) {
    fail('A public release image record is invalid.');
  }
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(message) {
  throw new PublicReleaseImagesError(message);
}
