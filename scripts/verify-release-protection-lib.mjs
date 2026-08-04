import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const RELEASE_PROTECTION_MARKER =
  'BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const REPOSITORY_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\/[a-z0-9._-]{1,100}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const API_VERSION = '2026-03-10';
const MAX_API_RESPONSE_BYTES = 1_048_576;
const MAX_TAG_RULESETS = 20;

export class ReleaseProtectionError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ReleaseProtectionError';
  }
}

export async function verifyReleaseProtection({
  version,
  candidate,
  repository,
  ownerAccount,
  rulesets,
  immutableReleases,
  tagReference,
  annotatedTag,
  release,
  records,
  inspectTag,
  inspectPublicTag,
  digestManifestSha256,
}) {
  const identity = validateIdentity({ candidate, repository, version });
  if (!/^[0-9a-f]{64}$/u.test(digestManifestSha256 ?? '')) {
    fail('The release digest manifest hash is invalid.');
  }
  validateOwnerAccount(ownerAccount, identity.owner);
  const { creation, mutation } = validateRulesets({
    ownerAccount,
    repository,
    rulesets,
  });
  validateImmutableReleaseState(immutableReleases);
  validateSignedTag({
    annotatedTag,
    candidate,
    repository,
    tagReference,
    version,
  });
  validateRelease({ release, repository, version });

  if (!Array.isArray(records) || records.length !== 7) {
    fail('Release protection requires the exact seven-image inventory.');
  }
  if (
    typeof inspectTag !== 'function' ||
    typeof inspectPublicTag !== 'function'
  ) {
    fail('Authenticated and anonymous read-only GHCR inspectors are required.');
  }

  const destinations = new Set();
  for (const record of records) {
    validateImageRecord(record, {
      owner: identity.owner,
      version,
    });
    if (destinations.has(record.destination)) {
      fail('Release protection image records must be unique.');
    }
    destinations.add(record.destination);

    let state;
    try {
      state = await inspectTag(record);
    } catch (error) {
      throw new ReleaseProtectionError(
        'A release image version tag could not be inspected.',
        { cause: error }
      );
    }
    if (
      state?.status !== 'present' ||
      state.digest !== record.digest ||
      Object.keys(state).sort(compareAscii).join(',') !== 'digest,status'
    ) {
      fail('A release image version tag does not match its immutable digest.');
    }

    let publicState;
    try {
      publicState = await inspectPublicTag(record);
    } catch (error) {
      throw new ReleaseProtectionError(
        'A release image could not be inspected anonymously.',
        { cause: error }
      );
    }
    if (
      publicState?.status !== 'present' ||
      publicState.digest !== record.digest ||
      Object.keys(publicState).sort(compareAscii).join(',') !== 'digest,status'
    ) {
      fail('A release image is not anonymously readable at its exact digest.');
    }
  }

  return {
    candidate,
    creationRulesetId: creation.id,
    digestManifestSha256,
    images: records.length,
    immutableRelease: true,
    marker: RELEASE_PROTECTION_MARKER,
    mutationRulesetId: mutation.id,
    publicImagesVerified: true,
    releaseId: release.id,
    repository,
    signedTagVerified: true,
    tagObjectSha: annotatedTag.sha,
    version,
  };
}

export function createGitHubApiReader({
  token,
  fetchImplementation = globalThis.fetch,
  timeoutMilliseconds = 15_000,
}) {
  if (
    typeof token !== 'string' ||
    token.length === 0 ||
    token.length > 16_384
  ) {
    fail('A GitHub API credential is required.');
  }
  if (
    typeof fetchImplementation !== 'function' ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < 1_000 ||
    timeoutMilliseconds > 60_000
  ) {
    fail('The GitHub API reader configuration is invalid.');
  }

  return async (path) => {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/') ||
      path.length > 2_048 ||
      /[\r\n\\]/u.test(path)
    ) {
      fail('The GitHub API path is invalid.');
    }

    let response;
    try {
      response = await fetchImplementation(`https://api.github.com${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': API_VERSION,
        },
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMilliseconds),
      });
    } catch (error) {
      throw new ReleaseProtectionError(
        'GitHub release protection state could not be read.',
        { cause: error }
      );
    }
    if (response.status !== 200) {
      fail('GitHub release protection state returned an unexpected status.');
    }
    if (
      /(?:^|,)\s*<[^>]+>;\s*rel="next"(?:,|$)/u.test(
        response.headers.get('link') ?? ''
      )
    ) {
      fail('GitHub release protection state exceeded the bounded inventory.');
    }

    const source = await readBoundedText(response, MAX_API_RESPONSE_BYTES);
    try {
      return JSON.parse(source);
    } catch (error) {
      throw new ReleaseProtectionError(
        'GitHub release protection state was not valid JSON.',
        { cause: error }
      );
    }
  };
}

export function releaseProtectionRecordsFromManifest({
  source,
  owner,
  releaseConfig,
  version,
}) {
  validateIdentity({
    candidate: '0'.repeat(40),
    repository: `${owner}/repository`,
    version,
  });
  if (
    typeof source !== 'string' ||
    Buffer.byteLength(source) > 16_384 ||
    !source.endsWith('\n') ||
    source.includes('\r')
  ) {
    fail('IMAGE_DIGESTS.txt must be bounded canonical text.');
  }
  if (
    !plainObject(releaseConfig) ||
    releaseConfig.schemaVersion !== 1 ||
    !Array.isArray(releaseConfig.images) ||
    releaseConfig.images.length !== 7
  ) {
    fail('The release image configuration is invalid.');
  }
  const lines = source.slice(0, -1).split('\n');
  if (
    lines.length !== releaseConfig.images.length ||
    !sameArray([...lines].sort(compareAscii), lines)
  ) {
    fail('IMAGE_DIGESTS.txt must contain the canonical sorted release set.');
  }

  const byImage = new Map();
  for (const line of lines) {
    const match = line.match(
      /^ghcr\.io\/(?<owner>[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?)\/(?<image>byok-grid-[a-z0-9-]+)@(?<digest>sha256:[0-9a-f]{64})$/u
    );
    if (
      !match?.groups ||
      match.groups.owner !== owner ||
      byImage.has(match.groups.image)
    ) {
      fail('IMAGE_DIGESTS.txt does not match the release owner and image set.');
    }
    byImage.set(match.groups.image, match.groups.digest);
  }

  const targets = new Set();
  const records = releaseConfig.images.map((entry) => {
    if (
      !plainObject(entry) ||
      typeof entry.target !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/u.test(entry.target) ||
      typeof entry.image !== 'string' ||
      !/^byok-grid-[a-z0-9-]+$/u.test(entry.image) ||
      targets.has(entry.target) ||
      !byImage.has(entry.image)
    ) {
      fail('The release image configuration does not match IMAGE_DIGESTS.txt.');
    }
    targets.add(entry.target);
    const digest = byImage.get(entry.image);
    const repository = `ghcr.io/${owner}/${entry.image}`;
    return {
      destination: `${repository}:${version}`,
      digest,
      image: entry.image,
      repository,
      source: `${repository}@${digest}`,
      target: entry.target,
      version,
    };
  });
  return {
    digestManifestSha256: createHash('sha256').update(source).digest('hex'),
    records,
  };
}

export async function readLiveReleaseProtectionState({
  readGitHub,
  repository,
  version,
}) {
  const { owner } = validateIdentity({
    candidate: '0'.repeat(40),
    repository,
    version,
  });
  if (typeof readGitHub !== 'function') {
    fail('A GitHub API reader is required.');
  }
  const tag = `v${version}`;
  const encodedTag = encodeURIComponent(tag);
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepository = repository
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  const [ownerAccount, summaries, immutableReleases, tagReference, release] =
    await Promise.all([
      safeRead(readGitHub, `/users/${encodedOwner}`),
      safeRead(
        readGitHub,
        `/repos/${encodedRepository}/rulesets?includes_parents=true&per_page=100`
      ),
      safeRead(readGitHub, `/repos/${encodedRepository}/immutable-releases`),
      safeRead(
        readGitHub,
        `/repos/${encodedRepository}/git/ref/tags/${encodedTag}`
      ),
      safeRead(
        readGitHub,
        `/repos/${encodedRepository}/releases/tags/${encodedTag}`
      ),
    ]);

  if (!Array.isArray(summaries) || summaries.length > 100) {
    fail('The repository ruleset inventory is invalid.');
  }
  const tagSummaries = summaries.filter(
    (ruleset) => ruleset?.target === 'tag' && ruleset.enforcement === 'active'
  );
  if (tagSummaries.length === 0 || tagSummaries.length > MAX_TAG_RULESETS) {
    fail('The active tag ruleset inventory is invalid.');
  }
  const rulesets = await Promise.all(
    tagSummaries.map((ruleset) => {
      if (!Number.isSafeInteger(ruleset.id) || ruleset.id <= 0) {
        fail('An active tag ruleset has an invalid identity.');
      }
      return safeRead(
        readGitHub,
        `/repos/${encodedRepository}/rulesets/${ruleset.id}`
      );
    })
  );

  if (
    tagReference?.object?.type !== 'tag' ||
    !SHA_PATTERN.test(tagReference.object.sha ?? '')
  ) {
    fail('The release tag reference is not a signed annotated tag.');
  }
  const annotatedTag = await safeRead(
    readGitHub,
    `/repos/${encodedRepository}/git/tags/${tagReference.object.sha}`
  );

  return {
    annotatedTag,
    immutableReleases,
    ownerAccount,
    release,
    rulesets,
    tagReference,
  };
}

export function writeReleaseProtectionEvidence(path, result) {
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 4_096 ||
    !plainObject(result) ||
    result.marker !== RELEASE_PROTECTION_MARKER
  ) {
    fail('The release protection evidence output is invalid.');
  }
  try {
    writeFileSync(resolve(path), `${JSON.stringify(result)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    throw new ReleaseProtectionError(
      'The release protection evidence could not be written exclusively.',
      { cause: error }
    );
  }
}

function validateIdentity({ candidate, repository, version }) {
  if (
    typeof version !== 'string' ||
    version.length > 128 ||
    !SEMVER_PATTERN.test(version)
  ) {
    fail('The release protection version must be canonical SemVer.');
  }
  if (!SHA_PATTERN.test(candidate ?? '')) {
    fail(
      'The release protection candidate must be a full lowercase commit SHA.'
    );
  }
  if (
    typeof repository !== 'string' ||
    repository !== repository.toLowerCase() ||
    !REPOSITORY_PATTERN.test(repository)
  ) {
    fail('The release protection repository identity is invalid.');
  }
  return { owner: repository.split('/')[0] };
}

function validateOwnerAccount(ownerAccount, owner) {
  if (
    !plainObject(ownerAccount) ||
    !Number.isSafeInteger(ownerAccount.id) ||
    ownerAccount.id <= 0 ||
    ownerAccount.login?.toLowerCase() !== owner ||
    ownerAccount.type !== 'User'
  ) {
    fail('The repository owner identity is invalid.');
  }
}

function validateRulesets({ ownerAccount, repository, rulesets }) {
  if (!Array.isArray(rulesets) || rulesets.length > MAX_TAG_RULESETS) {
    fail('The release tag ruleset inventory is invalid.');
  }
  const matching = rulesets.filter((ruleset) =>
    baseRulesetMatches(ruleset, repository)
  );
  const mutation = matching.filter(
    (ruleset) =>
      exactRuleTypes(ruleset.rules, [
        'deletion',
        'non_fast_forward',
        'update',
      ]) &&
      Array.isArray(ruleset.bypass_actors) &&
      ruleset.bypass_actors.length === 0 &&
      ruleset.current_user_can_bypass === 'never'
  );
  const creation = matching.filter(
    (ruleset) =>
      exactRuleTypes(ruleset.rules, ['creation']) &&
      exactCreationBypass(ruleset.bypass_actors, ownerAccount.id)
  );
  if (mutation.length !== 1) {
    fail('Exactly one no-bypass release tag mutation ruleset is required.');
  }
  if (creation.length !== 1) {
    fail('Exactly one owner-only release tag creation ruleset is required.');
  }
  return { creation: creation[0], mutation: mutation[0] };
}

function baseRulesetMatches(ruleset, repository) {
  if (!plainObject(ruleset)) return false;
  if (
    !Number.isSafeInteger(ruleset.id) ||
    ruleset.id <= 0 ||
    ruleset.target !== 'tag' ||
    ruleset.source_type !== 'Repository' ||
    ruleset.source?.toLowerCase() !== repository ||
    ruleset.enforcement !== 'active' ||
    !plainObject(ruleset.conditions) ||
    !plainObject(ruleset.conditions.ref_name) ||
    !sameArray(ruleset.conditions.ref_name.include, ['refs/tags/v*']) ||
    !sameArray(ruleset.conditions.ref_name.exclude, [])
  ) {
    return false;
  }
  return (
    ruleset._links?.html?.href ===
    `https://github.com/${repository}/rules/${ruleset.id}`
  );
}

function exactRuleTypes(rules, expected) {
  if (!Array.isArray(rules) || rules.length !== expected.length) return false;
  const types = rules.map((rule) => {
    if (!plainObject(rule) || Object.keys(rule).join(',') !== 'type')
      return null;
    return rule.type;
  });
  return sameArray(types.sort(compareAscii), expected.sort(compareAscii));
}

function exactCreationBypass(actors, ownerId) {
  if (!Array.isArray(actors) || actors.length !== 1) return false;
  const actor = actors[0];
  return (
    plainObject(actor) &&
    actor.actor_id === ownerId &&
    actor.actor_type === 'User' &&
    actor.bypass_mode === 'always' &&
    sameArray(Object.keys(actor).sort(compareAscii), [
      'actor_id',
      'actor_type',
      'bypass_mode',
    ])
  );
}

function validateImmutableReleaseState(value) {
  if (
    !plainObject(value) ||
    value.enabled !== true ||
    typeof value.enforced_by_owner !== 'boolean'
  ) {
    fail('Repository-level immutable GitHub Releases must be enabled.');
  }
}

function validateSignedTag({
  annotatedTag,
  candidate,
  repository,
  tagReference,
  version,
}) {
  const tag = `v${version}`;
  if (
    !plainObject(tagReference) ||
    tagReference.ref !== `refs/tags/${tag}` ||
    tagReference.url !==
      `https://api.github.com/repos/${repository}/git/refs/tags/${tag}` ||
    tagReference.object?.type !== 'tag' ||
    !SHA_PATTERN.test(tagReference.object.sha ?? '')
  ) {
    fail('The release tag reference is not a signed annotated tag.');
  }
  if (
    !plainObject(annotatedTag) ||
    annotatedTag.sha !== tagReference.object.sha ||
    annotatedTag.tag !== tag ||
    annotatedTag.url !==
      `https://api.github.com/repos/${repository}/git/tags/${annotatedTag.sha}` ||
    annotatedTag.object?.type !== 'commit' ||
    annotatedTag.object.sha !== candidate ||
    annotatedTag.verification?.verified !== true ||
    annotatedTag.verification.reason !== 'valid'
  ) {
    fail('The release tag signature or candidate binding is invalid.');
  }
}

function validateRelease({ release, repository, version }) {
  const tag = `v${version}`;
  if (
    !plainObject(release) ||
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== version.includes('-') ||
    release.immutable !== true ||
    release.html_url !== `https://github.com/${repository}/releases/tag/${tag}`
  ) {
    fail('The immutable GitHub Release state is invalid.');
  }
}

function validateImageRecord(record, { owner, version }) {
  if (
    !plainObject(record) ||
    record.version !== version ||
    !DIGEST_PATTERN.test(record.digest ?? '') ||
    typeof record.image !== 'string' ||
    record.repository !== `ghcr.io/${owner}/${record.image}` ||
    record.destination !== `${record.repository}:${version}` ||
    record.source !== `${record.repository}@${record.digest}`
  ) {
    fail('A release protection image record is invalid.');
  }
}

async function safeRead(readGitHub, path) {
  try {
    return await readGitHub(path);
  } catch (error) {
    if (error instanceof ReleaseProtectionError) throw error;
    throw new ReleaseProtectionError(
      'GitHub release protection state could not be read.',
      { cause: error }
    );
  }
}

async function readBoundedText(response, maximumBytes) {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    fail('GitHub release protection state returned an unreadable response.');
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
        fail('GitHub release protection state exceeded the size limit.');
      }
      source += decoder.decode(value, { stream: true });
    }
    source += decoder.decode();
  } catch (error) {
    if (error instanceof ReleaseProtectionError) throw error;
    throw new ReleaseProtectionError(
      'GitHub release protection state returned an unreadable response.',
      { cause: error }
    );
  } finally {
    reader.releaseLock();
  }
  return source;
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(message) {
  throw new ReleaseProtectionError(message);
}
