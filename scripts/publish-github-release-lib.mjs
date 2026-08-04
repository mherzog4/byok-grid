import { verifyPublishedRelease } from './verify-published-release-lib.mjs';
import { verifyReleaseBundle } from './verify-release-bundle-lib.mjs';

export const GITHUB_RELEASE_PUBLICATION_MARKER =
  'BYOK_GRID_GITHUB_RELEASE_PUBLICATION_VERIFIED';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const MAX_RELEASE_RESPONSE_BYTES = 1_048_576;
const MAX_RELEASE_NOTES_BYTES = 262_144;
const OFFICIAL_REPOSITORY = 'mherzog4/byok-grid';

export class GitHubReleasePublicationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'GitHubReleasePublicationError';
  }
}

export async function publishGitHubRelease({
  version,
  directory,
  releaseNotes,
  inspectRelease,
  createRelease,
  verifyBundle = verifyReleaseBundle,
  wait = defaultWait,
  inspectionAttempts = 5,
}) {
  validateInputs({
    createRelease,
    directory,
    inspectRelease,
    inspectionAttempts,
    releaseNotes,
    version,
    wait,
  });
  try {
    await verifyBundle({ directory, version });
  } catch (error) {
    throw new GitHubReleasePublicationError(
      'The local release bundle failed verification before publication.',
      { cause: error }
    );
  }

  const initialState = await safeInspect(inspectRelease);
  if (initialState.status === 'present') {
    const verified = await verifyExistingRelease({
      directory,
      release: initialState.release,
      releaseNotes,
      version,
    });
    return result({
      created: false,
      recovered: false,
      release: initialState.release,
      verified,
      version,
    });
  }

  let creationError;
  try {
    await createRelease();
  } catch (error) {
    creationError = error;
  }

  const publishedState = await waitForPublishedRelease({
    inspectRelease,
    inspectionAttempts,
    wait,
  });
  if (publishedState.status !== 'present') {
    throw new GitHubReleasePublicationError(
      'The GitHub Release was not published before the verification deadline.',
      { cause: creationError }
    );
  }

  let verified;
  try {
    verified = await verifyPublishedRelease({
      directory,
      release: publishedState.release,
      releaseNotes,
      version,
    });
  } catch (error) {
    throw new GitHubReleasePublicationError(
      creationError
        ? 'Release creation failed and the existing GitHub Release conflicts with the local bundle.'
        : 'The newly published GitHub Release failed immutable verification.',
      { cause: error }
    );
  }

  return result({
    created: creationError === undefined,
    recovered: creationError !== undefined,
    release: publishedState.release,
    verified,
    version,
  });
}

export function createGitHubReleaseInspector({
  repository,
  version,
  token,
  fetchImplementation = globalThis.fetch,
  timeoutMilliseconds = 15_000,
}) {
  assertRepository(repository);
  assertVersion(version);
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 16_384
  ) {
    fail('The GitHub release credential is required.');
  }
  if (
    typeof fetchImplementation !== 'function' ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 60_000
  ) {
    fail('The GitHub release inspection configuration is invalid.');
  }

  const endpoint = `https://api.github.com/repos/${repository}/releases/tags/v${version}`;
  return async () => {
    let response;
    try {
      response = await fetchImplementation(endpoint, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'user-agent': 'byok-grid-release-publisher',
          'x-github-api-version': '2026-03-10',
        },
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
    } catch (error) {
      throw new GitHubReleasePublicationError(
        'The GitHub Release API could not be inspected.',
        { cause: error }
      );
    }
    if (response.status === 404) return { status: 'absent' };
    if (response.status !== 200) {
      fail('The GitHub Release API returned an unexpected status.');
    }
    const source = await readBoundedText(response, MAX_RELEASE_RESPONSE_BYTES);
    let release;
    try {
      release = JSON.parse(source);
    } catch (error) {
      throw new GitHubReleasePublicationError(
        'The GitHub Release API returned invalid JSON.',
        { cause: error }
      );
    }
    if (!release || typeof release !== 'object' || Array.isArray(release)) {
      fail('The GitHub Release API returned an invalid release object.');
    }
    return { release, status: 'present' };
  };
}

async function verifyExistingRelease({
  directory,
  release,
  releaseNotes,
  version,
}) {
  try {
    return await verifyPublishedRelease({
      directory,
      release,
      releaseNotes,
      version,
    });
  } catch (error) {
    throw new GitHubReleasePublicationError(
      'An existing GitHub Release conflicts with the local immutable bundle.',
      { cause: error }
    );
  }
}

async function waitForPublishedRelease({
  inspectRelease,
  inspectionAttempts,
  wait,
}) {
  for (let attempt = 1; attempt <= inspectionAttempts; attempt += 1) {
    const state = await safeInspect(inspectRelease);
    if (state.status === 'present') return state;
    if (attempt < inspectionAttempts) await wait(1_000);
  }
  return { status: 'absent' };
}

async function safeInspect(inspectRelease) {
  let state;
  try {
    state = await inspectRelease();
  } catch (error) {
    if (error instanceof GitHubReleasePublicationError) throw error;
    throw new GitHubReleasePublicationError(
      'The GitHub Release API could not be inspected.',
      { cause: error }
    );
  }
  if (state?.status === 'absent' && Object.keys(state).length === 1) {
    return state;
  }
  if (
    state?.status === 'present' &&
    Object.keys(state).length === 2 &&
    state.release &&
    typeof state.release === 'object' &&
    !Array.isArray(state.release)
  ) {
    return state;
  }
  fail('The GitHub Release API returned an invalid inspection result.');
}

async function readBoundedText(response, maximumBytes) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('The GitHub Release API returned an unreadable response.');
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
        fail('The GitHub Release API returned an oversized response.');
      }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
  } catch (error) {
    if (error instanceof GitHubReleasePublicationError) throw error;
    throw new GitHubReleasePublicationError(
      'The GitHub Release API returned an unreadable response.',
      { cause: error }
    );
  } finally {
    reader.releaseLock();
  }
  if (source.length === 0) {
    fail('The GitHub Release API returned an empty response.');
  }
  return source;
}

function result({ created, recovered, release, verified, version }) {
  return {
    created,
    existing: !created,
    immutable: verified.immutable,
    marker: GITHUB_RELEASE_PUBLICATION_MARKER,
    recovered,
    release,
    version,
  };
}

function validateInputs({
  version,
  directory,
  releaseNotes,
  inspectRelease,
  createRelease,
  wait,
  inspectionAttempts,
}) {
  assertVersion(version);
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.length > 4_096
  ) {
    fail('The local release bundle directory is required.');
  }
  if (
    typeof releaseNotes !== 'string' ||
    releaseNotes.length === 0 ||
    Buffer.byteLength(releaseNotes) > MAX_RELEASE_NOTES_BYTES ||
    !releaseNotes.endsWith('\n')
  ) {
    fail('The reviewed release notes must be canonical bounded text.');
  }
  if (
    typeof inspectRelease !== 'function' ||
    typeof createRelease !== 'function' ||
    typeof wait !== 'function' ||
    !Number.isSafeInteger(inspectionAttempts) ||
    inspectionAttempts < 1 ||
    inspectionAttempts > 10
  ) {
    fail('The GitHub release publication operations are invalid.');
  }
}

function assertVersion(version) {
  if (
    typeof version !== 'string' ||
    version.length > 128 ||
    !SEMVER_PATTERN.test(version)
  ) {
    fail('The GitHub release version must be canonical SemVer.');
  }
}

function assertRepository(repository) {
  if (repository !== OFFICIAL_REPOSITORY) {
    fail('The GitHub release repository identity is invalid.');
  }
}

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function fail(message) {
  throw new GitHubReleasePublicationError(message);
}
