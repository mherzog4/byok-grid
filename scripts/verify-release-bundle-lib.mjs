import { createHash } from 'node:crypto';
import {
  createReadStream,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { generateHelmDigestValues } from './generate-helm-digest-values.mjs';
import { releaseDigestTargets } from './package-release.mjs';
import { verifyReleaseImageSmokeManifest } from './verify-release-image-smoke-lib.mjs';

export const RELEASE_BUNDLE_MARKER = 'BYOK_GRID_RELEASE_BUNDLE_VERIFIED';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const CHECKSUM_LINE_PATTERN =
  /^(?<digest>[0-9a-f]{64})  (?<name>[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/u;
const MAX_ARCHIVE_BYTES = 1_073_741_824;
const MAX_TEXT_BYTES = 262_144;

export class ReleaseBundleError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ReleaseBundleError';
  }
}

export async function verifyReleaseBundle({
  version,
  directory,
  rootDirectory = process.cwd(),
}) {
  if (
    typeof version !== 'string' ||
    version.length > 128 ||
    !SEMVER_PATTERN.test(version)
  ) {
    fail('The release bundle version must be canonical SemVer.');
  }
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.length > 4_096 ||
    typeof rootDirectory !== 'string' ||
    rootDirectory.length === 0 ||
    rootDirectory.length > 4_096
  ) {
    fail('The release bundle directory is required.');
  }

  const root = resolve(rootDirectory);
  const bundle = resolve(root, directory);
  const bundleMetadata = safeMetadata(bundle);
  if (!bundleMetadata.isDirectory()) {
    fail('The release bundle path must be a real directory.');
  }

  const releaseConfig = readTrustedJson(join(root, 'release-images.json'));
  const rootPackage = readTrustedJson(join(root, 'package.json'));
  if (rootPackage?.name !== 'byok-grid' || rootPackage.version !== version) {
    fail('The release bundle version does not match the source version.');
  }
  const sdkPackage = readTrustedJson(
    join(root, 'packages/connector-sdk/package.json')
  );
  if (
    sdkPackage?.name !== '@byok-grid/connector-sdk' ||
    typeof sdkPackage.version !== 'string' ||
    sdkPackage.version.length > 128 ||
    !SEMVER_PATTERN.test(sdkPackage.version)
  ) {
    fail('The connector SDK package identity is invalid.');
  }

  const chartName = `byok-grid-${version}.tgz`;
  const sdkName = `byok-grid-connector-sdk-${sdkPackage.version}.tgz`;
  const expectedAssets = [
    'IMAGE_DIGESTS.txt',
    'IMAGE_SMOKE.jsonl',
    'SHA256SUMS',
    chartName,
    sdkName,
    'values.digests.yaml',
  ].sort(compareAscii);
  const actualAssets = safeDirectoryEntries(bundle).sort(compareAscii);
  if (
    actualAssets.length !== expectedAssets.length ||
    actualAssets.some((name, index) => name !== expectedAssets[index])
  ) {
    fail('The release bundle must contain the exact expected asset set.');
  }

  for (const name of expectedAssets) {
    const metadata = safeMetadata(join(bundle, name));
    if (
      !metadata.isFile() ||
      metadata.size === 0 ||
      metadata.size > MAX_ARCHIVE_BYTES
    ) {
      fail('Every release bundle asset must be a bounded regular file.');
    }
  }

  const checksummedAssets = expectedAssets.filter(
    (name) => name !== 'SHA256SUMS'
  );
  const checksumSource = readBoundedText(join(bundle, 'SHA256SUMS'));
  const checksums = parseChecksumManifest(checksumSource, checksummedAssets);
  for (const name of checksummedAssets) {
    let actualDigest;
    try {
      actualDigest = await hashFile(join(bundle, name));
    } catch (error) {
      throw new ReleaseBundleError('A release asset could not be hashed.', {
        cause: error,
      });
    }
    if (actualDigest !== checksums.get(name)) {
      fail('A release asset does not match SHA256SUMS.');
    }
  }

  const digestManifest = readBoundedText(join(bundle, 'IMAGE_DIGESTS.txt'));
  assertCanonicalLines(digestManifest, releaseConfig?.images?.length);
  let digestTargets;
  try {
    digestTargets = releaseDigestTargets(digestManifest, releaseConfig);
  } catch (error) {
    throw new ReleaseBundleError('IMAGE_DIGESTS.txt is invalid.', {
      cause: error,
    });
  }

  const values = readBoundedText(join(bundle, 'values.digests.yaml'));
  let expectedValues;
  try {
    expectedValues = generateHelmDigestValues(digestManifest, releaseConfig);
  } catch (error) {
    throw new ReleaseBundleError('The release image mapping is invalid.', {
      cause: error,
    });
  }
  if (values !== expectedValues) {
    fail('values.digests.yaml does not match IMAGE_DIGESTS.txt.');
  }

  const smokeManifest = readBoundedText(join(bundle, 'IMAGE_SMOKE.jsonl'));
  let smokeRecords;
  try {
    smokeRecords = verifyReleaseImageSmokeManifest(smokeManifest, {
      expectedImages: [...digestTargets].map(([target, digest]) => ({
        digest,
        target,
      })),
    });
  } catch (error) {
    throw new ReleaseBundleError('IMAGE_SMOKE.jsonl is invalid.', {
      cause: error,
    });
  }

  return {
    assets: expectedAssets.length,
    images: digestTargets.size,
    marker: RELEASE_BUNDLE_MARKER,
    smokeRecords: smokeRecords.length,
    version,
  };
}

function parseChecksumManifest(source, expectedAssets) {
  if (!source.endsWith('\n') || source.includes('\r')) {
    fail('SHA256SUMS must be canonical text.');
  }
  const lines = source.slice(0, -1).split('\n');
  if (lines.length !== expectedAssets.length) {
    fail('SHA256SUMS must cover the exact release asset set.');
  }
  const records = new Map();
  for (const line of lines) {
    const match = line.match(CHECKSUM_LINE_PATTERN);
    if (
      !match?.groups ||
      !expectedAssets.includes(match.groups.name) ||
      records.has(match.groups.name)
    ) {
      fail('SHA256SUMS contains an invalid or duplicate record.');
    }
    records.set(match.groups.name, match.groups.digest);
  }
  const canonical = `${expectedAssets
    .map((name) => `${records.get(name)}  ${name}`)
    .join('\n')}\n`;
  if (source !== canonical) {
    fail('SHA256SUMS must be canonical text.');
  }
  return records;
}

function assertCanonicalLines(source, expectedCount) {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount <= 0 ||
    !source.endsWith('\n') ||
    source.includes('\r')
  ) {
    fail('IMAGE_DIGESTS.txt must be canonical text.');
  }
  const lines = source.slice(0, -1).split('\n');
  if (
    lines.length !== expectedCount ||
    lines.some((line) => line.length === 0 || line !== line.trim()) ||
    lines.some((line, index) => index > 0 && line <= lines[index - 1])
  ) {
    fail('IMAGE_DIGESTS.txt must be canonical text.');
  }
}

function readTrustedJson(path) {
  const source = readBoundedText(path);
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new ReleaseBundleError('A release configuration file is invalid.', {
      cause: error,
    });
  }
}

function readBoundedText(path) {
  const metadata = safeMetadata(path);
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > MAX_TEXT_BYTES
  ) {
    fail('A release text file must be a bounded regular file.');
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new ReleaseBundleError('A release text file could not be read.', {
      cause: error,
    });
  }
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
    throw new ReleaseBundleError('A required release path is unavailable.', {
      cause: error,
    });
  }
}

function safeDirectoryEntries(path) {
  try {
    return readdirSync(path);
  } catch (error) {
    throw new ReleaseBundleError('The release bundle could not be read.', {
      cause: error,
    });
  }
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(message) {
  throw new ReleaseBundleError(message);
}
