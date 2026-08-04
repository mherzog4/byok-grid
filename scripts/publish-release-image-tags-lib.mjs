import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const RELEASE_IMAGE_TAGS_MARKER =
  'BYOK_GRID_RELEASE_IMAGE_TAGS_VERIFIED';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_PATTERN = /^byok-grid-[a-z0-9-]+$/u;
const TARGET_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const MAX_RECORD_BYTES = 512;

export class ReleaseImageTagsError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ReleaseImageTagsError';
  }
}

export function readReleaseImageTagInputs({
  version,
  owner,
  digestsDirectory,
  releaseConfig,
}) {
  assertVersion(version);
  assertOwner(owner);
  if (
    typeof digestsDirectory !== 'string' ||
    digestsDirectory.length === 0 ||
    digestsDirectory.length > 4_096
  ) {
    fail('The release digest directory is required.');
  }

  const images = validateReleaseConfig(releaseConfig);
  const directory = resolve(digestsDirectory);
  const directoryMetadata = safeMetadata(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    fail('The release digest path must be a real directory.');
  }

  const expectedNames = images
    .map(({ target }) => `${target}.txt`)
    .sort(compareAscii);
  const actualNames = safeDirectoryEntries(directory).sort(compareAscii);
  if (
    actualNames.length !== expectedNames.length ||
    actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    fail('The release digest directory must contain the exact image records.');
  }

  return images.map(({ target, image }) => {
    const path = join(directory, `${target}.txt`);
    const metadata = safeMetadata(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size > MAX_RECORD_BYTES
    ) {
      fail('Every release digest record must be a bounded regular file.');
    }

    let source;
    try {
      source = readFileSync(path, 'utf8').replace(/\n$/u, '');
    } catch (error) {
      throw new ReleaseImageTagsError(
        'A release digest record could not be read.',
        { cause: error }
      );
    }
    const repository = `ghcr.io/${owner}/${image}`;
    const expectedPrefix = `${repository}@`;
    if (
      !source.startsWith(expectedPrefix) ||
      source.includes('\r') ||
      source.includes('\n')
    ) {
      fail('A release digest record has an invalid immutable reference.');
    }
    const digest = source.slice(expectedPrefix.length);
    if (!DIGEST_PATTERN.test(digest)) {
      fail('A release digest record has an invalid immutable reference.');
    }

    return {
      destination: `${repository}:${version}`,
      digest,
      image,
      repository,
      source,
      target,
      version,
    };
  });
}

export async function publishReleaseImageTags({
  records,
  inspectTag,
  publishTag,
}) {
  if (!Array.isArray(records) || records.length === 0) {
    fail('At least one release image record is required.');
  }
  if (typeof inspectTag !== 'function' || typeof publishTag !== 'function') {
    fail('Release image registry operations are required.');
  }

  const preflight = [];
  const destinations = new Set();
  const releaseVersion = records[0]?.version;
  for (const record of records) {
    validateRecord(record);
    if (
      record.version !== releaseVersion ||
      destinations.has(record.destination)
    ) {
      fail(
        'Release image publication records must be unique and version-bound.'
      );
    }
    destinations.add(record.destination);
  }
  for (const record of records) {
    preflight.push(await safeInspect(inspectTag, record));
  }

  for (let index = 0; index < records.length; index += 1) {
    const state = preflight[index];
    if (state.status === 'present' && state.digest !== records[index].digest) {
      fail('A release image version tag already points to another digest.');
    }
  }

  let created = 0;
  let existing = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const initialState = preflight[index];
    if (initialState.status === 'present') {
      existing += 1;
      continue;
    }

    const currentState = await safeInspect(inspectTag, record);
    if (currentState.status === 'present') {
      if (currentState.digest !== record.digest) {
        fail('A release image version tag changed during publication.');
      }
      existing += 1;
      continue;
    }

    try {
      await publishTag(record);
    } catch (error) {
      throw new ReleaseImageTagsError(
        'A release image version tag could not be published.',
        { cause: error }
      );
    }
    const publishedState = await safeInspect(inspectTag, record);
    if (
      publishedState.status !== 'present' ||
      publishedState.digest !== record.digest
    ) {
      fail('A published release image tag failed digest verification.');
    }
    created += 1;
  }

  for (const record of records) {
    const finalState = await safeInspect(inspectTag, record);
    if (
      finalState.status !== 'present' ||
      finalState.digest !== record.digest
    ) {
      fail('The final release image tag set failed digest verification.');
    }
  }

  return {
    created,
    existing,
    images: records.length,
    marker: RELEASE_IMAGE_TAGS_MARKER,
    version: releaseVersion,
  };
}

export function createGhcrTagInspector({
  actor,
  token,
  fetchImplementation = globalThis.fetch,
  timeoutMilliseconds = 15_000,
}) {
  if (
    typeof actor !== 'string' ||
    actor.length === 0 ||
    actor.length > 100 ||
    /[^\u0021-\u007e]|:/u.test(actor)
  ) {
    fail('The GHCR actor identity is invalid.');
  }
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 16_384
  ) {
    fail('The GHCR credential is required.');
  }
  if (
    typeof fetchImplementation !== 'function' ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 60_000
  ) {
    fail('The GHCR inspection configuration is invalid.');
  }

  const bearerTokens = new Map();
  return async (record) => {
    validateRecord(record);
    const repositoryPath = record.repository.slice('ghcr.io/'.length);
    let bearerToken = bearerTokens.get(record.repository);
    if (!bearerToken) {
      bearerToken = await requestBearerToken({
        actor,
        fetchImplementation,
        repositoryPath,
        timeoutMilliseconds,
        token,
      });
      bearerTokens.set(record.repository, bearerToken);
    }

    let response;
    try {
      response = await fetchImplementation(
        `https://ghcr.io/v2/${repositoryPath}/manifests/${encodeURIComponent(record.version)}`,
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
      throw new ReleaseImageTagsError(
        'The release image registry could not be inspected.',
        { cause: error }
      );
    }
    if (response.status === 404) return { status: 'absent' };
    if (response.status !== 200) {
      fail('The release image registry returned an unexpected status.');
    }
    const digest = response.headers.get('docker-content-digest');
    if (!digest || !DIGEST_PATTERN.test(digest)) {
      fail('The release image registry returned an invalid digest.');
    }
    return { digest, status: 'present' };
  };
}

async function requestBearerToken({
  actor,
  token,
  repositoryPath,
  fetchImplementation,
  timeoutMilliseconds,
}) {
  const endpoint = new URL('https://ghcr.io/token');
  endpoint.searchParams.set('service', 'ghcr.io');
  endpoint.searchParams.set('scope', `repository:${repositoryPath}:pull`);
  let response;
  try {
    response = await fetchImplementation(endpoint, {
      headers: {
        authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}`,
      },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch (error) {
    throw new ReleaseImageTagsError(
      'GHCR authorization could not be established.',
      { cause: error }
    );
  }
  if (response.status !== 200) {
    fail('GHCR authorization returned an unexpected status.');
  }
  const source = await readBoundedText(response, 32_768);
  if (source.length === 0) {
    fail('GHCR authorization returned an invalid response.');
  }
  let body;
  try {
    body = JSON.parse(source);
  } catch (error) {
    throw new ReleaseImageTagsError(
      'GHCR authorization returned an invalid response.',
      { cause: error }
    );
  }
  const bearerToken = body?.token ?? body?.access_token;
  if (
    typeof bearerToken !== 'string' ||
    bearerToken.length === 0 ||
    bearerToken.length > 16_384
  ) {
    fail('GHCR authorization returned an invalid response.');
  }
  return bearerToken;
}

async function readBoundedText(response, maximumBytes) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('GHCR authorization returned an unreadable response.');
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
        fail('GHCR authorization returned an invalid response.');
      }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
  } catch (error) {
    if (error instanceof ReleaseImageTagsError) throw error;
    throw new ReleaseImageTagsError(
      'GHCR authorization returned an unreadable response.',
      { cause: error }
    );
  } finally {
    reader.releaseLock();
  }
  return source;
}

async function safeInspect(inspectTag, record) {
  let state;
  try {
    state = await inspectTag(record);
  } catch (error) {
    if (error instanceof ReleaseImageTagsError) throw error;
    throw new ReleaseImageTagsError(
      'The release image registry could not be inspected.',
      { cause: error }
    );
  }
  if (state?.status === 'absent' && Object.keys(state).length === 1) {
    return state;
  }
  if (
    state?.status === 'present' &&
    Object.keys(state).length === 2 &&
    DIGEST_PATTERN.test(state.digest)
  ) {
    return state;
  }
  fail('The release image registry returned an invalid inspection result.');
}

function validateReleaseConfig(config) {
  if (config?.schemaVersion !== 1 || !Array.isArray(config.images)) {
    fail('release-images.json must use schemaVersion 1.');
  }
  const targets = new Set();
  const images = new Set();
  const records = [];
  for (const entry of config.images) {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      typeof entry.target !== 'string' ||
      typeof entry.image !== 'string' ||
      !TARGET_PATTERN.test(entry.target) ||
      !IMAGE_PATTERN.test(entry.image) ||
      targets.has(entry.target) ||
      images.has(entry.image)
    ) {
      fail('Release image targets and names must be safe and unique.');
    }
    targets.add(entry.target);
    images.add(entry.image);
    records.push({ image: entry.image, target: entry.target });
  }
  if (records.length === 0) fail('At least one release image is required.');
  return records;
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
    !TARGET_PATTERN.test(record.target) ||
    !IMAGE_PATTERN.test(record.image) ||
    !DIGEST_PATTERN.test(record.digest) ||
    !SEMVER_PATTERN.test(record.version) ||
    !repositoryMatch?.groups ||
    repositoryMatch.groups.owner.includes('--') ||
    repositoryMatch.groups.image !== record.image ||
    record.source !== `${record.repository}@${record.digest}` ||
    record.destination !== `${record.repository}:${record.version}`
  ) {
    fail('A release image publication record is invalid.');
  }
}

function assertVersion(version) {
  if (
    typeof version !== 'string' ||
    version.length > 128 ||
    !SEMVER_PATTERN.test(version)
  ) {
    fail('The release image version must be canonical SemVer.');
  }
}

function assertOwner(owner) {
  if (
    typeof owner !== 'string' ||
    owner.length > 100 ||
    !OWNER_PATTERN.test(owner) ||
    owner.includes('--')
  ) {
    fail('The GHCR owner must be a canonical lowercase GitHub identity.');
  }
}

function safeMetadata(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    throw new ReleaseImageTagsError(
      'A required release image path is unavailable.',
      { cause: error }
    );
  }
}

function safeDirectoryEntries(path) {
  try {
    return readdirSync(path);
  } catch (error) {
    throw new ReleaseImageTagsError(
      'The release digest directory could not be read.',
      { cause: error }
    );
  }
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(message) {
  throw new ReleaseImageTagsError(message);
}
