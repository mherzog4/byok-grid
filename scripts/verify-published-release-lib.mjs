import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PUBLISHED_RELEASE_MARKER = 'BYOK_GRID_PUBLISHED_RELEASE_VERIFIED';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const SAFE_ASSET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ASSET_BYTES = 1_073_741_824;
const EXPECTED_ASSET_COUNT = 6;

export class PublishedReleaseError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PublishedReleaseError';
  }
}

export async function verifyPublishedRelease({
  version,
  directory,
  release,
  releaseNotes,
  repository = 'mherzog4/byok-grid',
}) {
  if (
    typeof version !== 'string' ||
    version.length > 128 ||
    !SEMVER_PATTERN.test(version)
  ) {
    fail('The published release version must be canonical SemVer.');
  }
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.length > 4_096
  ) {
    fail('The packaged release directory is required.');
  }
  if (repository !== 'mherzog4/byok-grid') {
    fail('The published release repository identity is invalid.');
  }
  if (!release || typeof release !== 'object' || Array.isArray(release)) {
    fail('The GitHub release response must be an object.');
  }
  if (
    typeof releaseNotes !== 'string' ||
    releaseNotes.length === 0 ||
    !releaseNotes.endsWith('\n')
  ) {
    fail('The reviewed release notes must be canonical nonempty text.');
  }

  const expectedPrerelease = version.includes('-');
  const expectedTag = `v${version}`;
  if (
    !Number.isSafeInteger(release.id) ||
    release.id <= 0 ||
    release.tag_name !== expectedTag ||
    release.name !== `BYOK Grid ${version}` ||
    release.draft !== false ||
    release.prerelease !== expectedPrerelease ||
    release.immutable !== true ||
    release.html_url !==
      `https://github.com/${repository}/releases/tag/${expectedTag}` ||
    typeof release.published_at !== 'string' ||
    !canonicalTimestamp(release.published_at) ||
    (release.body !== releaseNotes && `${release.body}\n` !== releaseNotes)
  ) {
    fail('The published GitHub release metadata is invalid.');
  }
  if (!Array.isArray(release.assets)) {
    fail('The published GitHub release assets must be an array.');
  }

  const bundle = resolve(directory);
  const bundleMetadata = safeMetadata(bundle);
  if (!bundleMetadata.isDirectory()) {
    fail('The packaged release path must be a real directory.');
  }
  const localNames = safeDirectoryEntries(bundle).sort(compareAscii);
  if (localNames.length !== EXPECTED_ASSET_COUNT) {
    fail('The packaged release must contain exactly six assets.');
  }

  const remoteAssets = new Map();
  for (const asset of release.assets) {
    if (
      !asset ||
      typeof asset !== 'object' ||
      Array.isArray(asset) ||
      typeof asset.name !== 'string' ||
      !SAFE_ASSET_NAME_PATTERN.test(asset.name) ||
      remoteAssets.has(asset.name)
    ) {
      fail('The published release contains an invalid or duplicate asset.');
    }
    remoteAssets.set(asset.name, asset);
  }
  const remoteNames = [...remoteAssets.keys()].sort(compareAscii);
  if (
    remoteNames.length !== localNames.length ||
    remoteNames.some((name, index) => name !== localNames[index])
  ) {
    fail('The published release does not contain the exact packaged assets.');
  }

  for (const name of localNames) {
    if (!SAFE_ASSET_NAME_PATTERN.test(name)) {
      fail('The packaged release contains an unsafe asset name.');
    }
    const path = join(bundle, name);
    const metadata = safeMetadata(path);
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > MAX_ASSET_BYTES
    ) {
      fail('Every packaged release asset must be a bounded regular file.');
    }

    const asset = remoteAssets.get(name);
    const expectedUrl = `https://github.com/${repository}/releases/download/${expectedTag}/${encodeURIComponent(name)}`;
    if (
      asset?.state !== 'uploaded' ||
      !Number.isSafeInteger(asset.size) ||
      asset.size !== metadata.size ||
      asset.browser_download_url !== expectedUrl
    ) {
      fail('A published release asset has invalid metadata.');
    }

    let digest;
    try {
      digest = await hashFile(path);
    } catch (error) {
      throw new PublishedReleaseError(
        'A packaged release asset could not be hashed.',
        { cause: error }
      );
    }
    if (asset.digest !== `sha256:${digest}`) {
      fail(
        'A published release asset digest does not match the packaged file.'
      );
    }
  }

  return {
    assets: localNames.length,
    immutable: true,
    marker: PUBLISHED_RELEASE_MARKER,
    prerelease: expectedPrerelease,
    version,
  };
}

function canonicalTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) {
    return false;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) return false;
  const normalized = parsed.toISOString();
  return normalized === value || normalized.replace(/\.000Z$/u, 'Z') === value;
}

async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function safeMetadata(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    throw new PublishedReleaseError(
      'A required published release path is unavailable.',
      { cause: error }
    );
  }
}

function safeDirectoryEntries(path) {
  try {
    return readdirSync(path);
  } catch (error) {
    throw new PublishedReleaseError(
      'The packaged release directory could not be read.',
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
  throw new PublishedReleaseError(message);
}
