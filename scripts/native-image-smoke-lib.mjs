import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';

import {
  RELEASE_IMAGE_SMOKE_MARKER,
  verifyReleaseImageSmoke,
  verifyReleaseImageSmokeEvidence,
  verifyReleaseImageSmokeManifest,
} from './verify-release-image-smoke-lib.mjs';

export const NATIVE_IMAGE_SMOKE_HOST_MARKER =
  'BYOK_GRID_NATIVE_IMAGE_SMOKE_HOST_VERIFIED';
export const NATIVE_MULTI_ARCH_IMAGE_SMOKE_MARKER =
  'BYOK_GRID_NATIVE_MULTI_ARCH_IMAGE_SMOKE_VERIFIED';

const CANDIDATE_PATTERN = /^[0-9a-f]{40}$/u;
const IMAGE_PATTERN = /^byok-grid-[a-z0-9-]+$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/u;
const TARGET_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const VERSION_TEXT_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/u;
const PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);
const PLATFORM_ARCHITECTURES = Object.freeze({
  'linux/amd64': 'amd64',
  'linux/arm64': 'arm64',
});
const MAXIMUM_MANIFEST_BYTES = 65_536;
const MAXIMUM_HOST_EVIDENCE_BYTES = 131_072;
const MAXIMUM_DOCKER_OUTPUT_BYTES = 8_192;
const MAXIMUM_SMOKE_OUTPUT_BYTES = 4_096;
const MAXIMUM_COLLECTION_SPAN_MS = 24 * 60 * 60 * 1_000;
const CLOCK_SKEW_MS = 5 * 60 * 1_000;
const OFFICIAL_OWNER = 'mherzog4';

export class NativeImageSmokeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'NativeImageSmokeError';
  }
}

export function collectNativeImageSmokeEvidence({
  candidateCommit,
  digestManifest,
  hostPlatform,
  now = new Date(),
  releaseConfig,
  releaseVersion,
  runCommand,
}) {
  const identity = validateIdentity({ candidateCommit, releaseVersion });
  const inventory = parseReleaseImageInventory(releaseConfig, digestManifest);
  const platform = supportedPlatform(hostPlatform);
  const verifiedAt = validDate(now, 'collection clock');
  if (typeof runCommand !== 'function') {
    fail('Native image smoke collection needs a command runner.');
  }

  const docker = inspectDockerServer(runCommand, platform);
  const releaseTargets = inventory.map(({ target }) => target);
  const records = inventory
    .map(({ digest, reference, target }) => {
      const raw = runDockerCommand(
        runCommand,
        [
          'run',
          '--rm',
          '--pull=always',
          '--platform',
          platform,
          '--network=none',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--pids-limit=64',
          reference,
          '--image-smoke',
        ],
        MAXIMUM_SMOKE_OUTPUT_BYTES,
        30_000,
        'A native release image did not complete its smoke contract.'
      );
      return verifyReleaseImageSmoke(raw.trim(), {
        expectedDigest: digest,
        expectedPlatform: platform,
        expectedTarget: target,
        releaseTargets,
      });
    })
    .sort(compareSmokeRecords);

  return {
    candidateCommit: identity.candidateCommit,
    digestManifestSha256: sha256(digestManifest),
    docker,
    marker: NATIVE_IMAGE_SMOKE_HOST_MARKER,
    platform,
    records,
    releaseVersion: identity.releaseVersion,
    schemaVersion: 1,
    verifiedAt: verifiedAt.toISOString(),
  };
}

export function verifyNativeImageSmokeBundle({
  candidateCommit,
  digestManifest,
  hostEvidence,
  now = new Date(),
  releaseConfig,
  releaseSmokeManifest,
  releaseVersion,
}) {
  const identity = validateIdentity({ candidateCommit, releaseVersion });
  const inventory = parseReleaseImageInventory(releaseConfig, digestManifest);
  const verificationClock = validDate(now, 'verification clock');
  const digestManifestSha256 = sha256(digestManifest);
  const expectedImages = inventory.map(({ digest, target }) => ({
    digest,
    target,
  }));
  const releaseRecords = verifyReleaseImageSmokeManifest(releaseSmokeManifest, {
    expectedImages,
  });

  if (!Array.isArray(hostEvidence) || hostEvidence.length !== 2) {
    fail('Native image smoke evidence requires exactly two host records.');
  }
  const verifiedHosts = hostEvidence
    .map((evidence) =>
      verifyNativeHostEvidence(evidence, {
        digestManifestSha256,
        expectedImages,
        identity,
        now: verificationClock,
      })
    )
    .sort(
      (left, right) =>
        PLATFORMS.indexOf(left.platform) - PLATFORMS.indexOf(right.platform)
    );
  if (verifiedHosts.some((host, index) => host.platform !== PLATFORMS[index])) {
    fail('Native image smoke evidence needs one host for each architecture.');
  }
  const hostTimes = verifiedHosts.map(({ verifiedAt }) =>
    new Date(verifiedAt).getTime()
  );
  if (
    Math.max(...hostTimes) - Math.min(...hostTimes) >
    MAXIMUM_COLLECTION_SPAN_MS
  ) {
    fail('Native host smoke evidence must be collected within 24 hours.');
  }

  const nativeRecords = verifiedHosts
    .flatMap(({ records }) => records)
    .sort(compareSmokeRecords);
  if (canonicalJson(nativeRecords) !== canonicalJson(releaseRecords)) {
    fail('Native host smoke records do not match the release smoke manifest.');
  }

  return {
    candidateCommit: identity.candidateCommit,
    digestManifestSha256,
    hostEvidence: verifiedHosts.map(({ sourceSha256, ...host }) => ({
      artifactSha256: sourceSha256,
      dockerServerVersion: host.docker.serverVersion,
      marker: NATIVE_IMAGE_SMOKE_HOST_MARKER,
      platform: host.platform,
      verifiedAt: host.verifiedAt,
    })),
    marker: NATIVE_MULTI_ARCH_IMAGE_SMOKE_MARKER,
    records: nativeRecords.length,
    releaseSmokeMarker: RELEASE_IMAGE_SMOKE_MARKER,
    releaseSmokeManifestSha256: sha256(releaseSmokeManifest),
    releaseVersion: identity.releaseVersion,
    schemaVersion: 1,
    verifiedAt: verificationClock.toISOString(),
  };
}

export function verifyNativeImageSmokeBundleFiles({
  amd64EvidencePath,
  arm64EvidencePath,
  candidateCommit,
  digestManifestPath,
  now,
  releaseConfigPath = 'release-images.json',
  releaseSmokeManifestPath,
  releaseVersion,
}) {
  const digestManifest = readBoundedFile(
    digestManifestPath,
    MAXIMUM_MANIFEST_BYTES,
    'The image digest manifest could not be read.'
  );
  const releaseSmokeManifest = readBoundedFile(
    releaseSmokeManifestPath,
    MAXIMUM_MANIFEST_BYTES,
    'The release smoke manifest could not be read.'
  );
  const releaseConfig = readCanonicalJsonFile(
    releaseConfigPath,
    MAXIMUM_MANIFEST_BYTES,
    'The release image configuration could not be read.',
    false
  ).value;
  const hostEvidence = [amd64EvidencePath, arm64EvidencePath].map((path) =>
    readCanonicalJsonFile(
      path,
      MAXIMUM_HOST_EVIDENCE_BYTES,
      'A native host evidence file could not be read.',
      true
    )
  );
  return verifyNativeImageSmokeBundle({
    candidateCommit,
    digestManifest,
    hostEvidence,
    now,
    releaseConfig,
    releaseSmokeManifest,
    releaseVersion,
  });
}

export function runtimePlatform(
  platform = process.platform,
  arch = process.arch
) {
  if (platform !== 'linux') {
    fail('Native image smoke collection requires a Linux host.');
  }
  if (arch === 'x64') return 'linux/amd64';
  if (arch === 'arm64') return 'linux/arm64';
  fail('Native image smoke collection requires amd64 or arm64 hardware.');
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortJson(value))}\n`;
}

function inspectDockerServer(runCommand, platform) {
  const raw = runDockerCommand(
    runCommand,
    [
      'version',
      '--format',
      '{"architecture":{{json .Server.Arch}},"operatingSystem":{{json .Server.Os}},"serverVersion":{{json .Server.Version}}}',
    ],
    MAXIMUM_DOCKER_OUTPUT_BYTES,
    15_000,
    'The Docker server identity could not be verified.'
  );
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new NativeImageSmokeError(
      'The Docker server returned malformed identity data.',
      { cause: error }
    );
  }
  const docker = exactObject(parsed, 'Docker server identity', [
    'architecture',
    'operatingSystem',
    'serverVersion',
  ]);
  if (
    docker.operatingSystem !== 'linux' ||
    docker.architecture !== PLATFORM_ARCHITECTURES[platform] ||
    typeof docker.serverVersion !== 'string' ||
    !VERSION_TEXT_PATTERN.test(docker.serverVersion)
  ) {
    fail('The Docker server does not match the native host architecture.');
  }
  return docker;
}

function runDockerCommand(
  runCommand,
  args,
  maximumBytes,
  timeout,
  failureMessage
) {
  let result;
  try {
    result = runCommand('docker', args, { timeout });
  } catch (error) {
    throw new NativeImageSmokeError(failureMessage, { cause: error });
  }
  if (
    !result ||
    result.status !== 0 ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) === 0 ||
    Buffer.byteLength(result.stdout) > maximumBytes
  ) {
    fail(failureMessage);
  }
  return result.stdout;
}

function verifyNativeHostEvidence(
  input,
  { digestManifestSha256, expectedImages, identity, now }
) {
  const wrapper =
    input && typeof input === 'object' && 'value' in input
      ? input
      : { source: canonicalJson(input), value: input };
  const value = exactObject(wrapper.value, 'native host evidence', [
    'candidateCommit',
    'digestManifestSha256',
    'docker',
    'marker',
    'platform',
    'records',
    'releaseVersion',
    'schemaVersion',
    'verifiedAt',
  ]);
  if (
    value.schemaVersion !== 1 ||
    value.marker !== NATIVE_IMAGE_SMOKE_HOST_MARKER ||
    value.candidateCommit !== identity.candidateCommit ||
    value.releaseVersion !== identity.releaseVersion ||
    value.digestManifestSha256 !== digestManifestSha256
  ) {
    fail('A native host evidence record does not match the release candidate.');
  }
  const platform = supportedPlatform(value.platform);
  const docker = exactObject(value.docker, 'native Docker identity', [
    'architecture',
    'operatingSystem',
    'serverVersion',
  ]);
  if (
    docker.operatingSystem !== 'linux' ||
    docker.architecture !== PLATFORM_ARCHITECTURES[platform] ||
    typeof docker.serverVersion !== 'string' ||
    !VERSION_TEXT_PATTERN.test(docker.serverVersion)
  ) {
    fail('A native host Docker identity does not match its platform.');
  }
  const verifiedAt = timestamp(value.verifiedAt, 'native verification time');
  if (verifiedAt.getTime() > now.getTime() + CLOCK_SKEW_MS) {
    fail('Native host smoke evidence cannot be collected in the future.');
  }
  if (
    !Array.isArray(value.records) ||
    value.records.length !== expectedImages.length
  ) {
    fail('A native host evidence record has an incomplete image set.');
  }
  const releaseTargets = expectedImages.map(({ target }) => target);
  const records = value.records.map((record, index) => {
    const expected = expectedImages[index];
    if (!expected || record?.target !== expected.target) {
      fail('Native host image records must use canonical target order.');
    }
    return verifyReleaseImageSmokeEvidence(record, {
      expectedDigest: expected.digest,
      expectedPlatform: platform,
      expectedTarget: expected.target,
      releaseTargets,
    });
  });
  return {
    docker,
    platform,
    records,
    sourceSha256: sha256(wrapper.source),
    verifiedAt: verifiedAt.toISOString(),
  };
}

function parseReleaseImageInventory(releaseConfig, digestManifest) {
  const config = exactObject(releaseConfig, 'release image configuration', [
    'images',
    'schemaVersion',
  ]);
  if (config.schemaVersion !== 1 || !Array.isArray(config.images)) {
    fail('The release image configuration must use schemaVersion 1.');
  }
  const targets = new Set();
  const images = new Map();
  for (const entry of config.images) {
    const image = exactObject(entry, 'release image entry', [
      'image',
      'target',
    ]);
    if (
      typeof image.target !== 'string' ||
      !TARGET_PATTERN.test(image.target) ||
      typeof image.image !== 'string' ||
      !IMAGE_PATTERN.test(image.image) ||
      targets.has(image.target) ||
      images.has(image.image)
    ) {
      fail('Release image targets and names must be safe and unique.');
    }
    targets.add(image.target);
    images.set(image.image, image.target);
  }
  if (images.size === 0) fail('The release image configuration is empty.');
  if (
    typeof digestManifest !== 'string' ||
    Buffer.byteLength(digestManifest) > MAXIMUM_MANIFEST_BYTES ||
    !digestManifest.endsWith('\n') ||
    digestManifest.includes('\r')
  ) {
    fail('The image digest manifest must be canonical bounded text.');
  }
  const lines = digestManifest.slice(0, -1).split('\n');
  if (lines.length !== images.size || lines.some((line) => line.length === 0)) {
    fail('The image digest manifest does not match the release inventory.');
  }
  if (lines.some((line, index) => index > 0 && lines[index - 1] >= line)) {
    fail('The image digest manifest must use canonical sorted order.');
  }
  const inventory = [];
  const observedTargets = new Set();
  for (const reference of lines) {
    const match = reference.match(
      new RegExp(
        `^ghcr\\.io/${OFFICIAL_OWNER}/(?<image>byok-grid-[a-z0-9-]+)@(?<digest>sha256:[0-9a-f]{64})$`,
        'u'
      )
    );
    const target = match?.groups ? images.get(match.groups.image) : undefined;
    if (!match?.groups || !target || observedTargets.has(target)) {
      fail('The image digest manifest contains an invalid release reference.');
    }
    observedTargets.add(target);
    inventory.push({
      digest: match.groups.digest,
      reference,
      target,
    });
  }
  if (observedTargets.size !== targets.size) {
    fail('The image digest manifest is incomplete.');
  }
  return inventory.sort((left, right) =>
    compareAscii(left.target, right.target)
  );
}

function validateIdentity({ candidateCommit, releaseVersion }) {
  if (
    typeof candidateCommit !== 'string' ||
    !CANDIDATE_PATTERN.test(candidateCommit)
  ) {
    fail('The candidate commit must be a lowercase 40-character SHA.');
  }
  if (
    typeof releaseVersion !== 'string' ||
    !SEMVER_PATTERN.test(releaseVersion)
  ) {
    fail('The release version must be canonical SemVer.');
  }
  return { candidateCommit, releaseVersion };
}

function readCanonicalJsonFile(path, maximumBytes, message, requireCanonical) {
  const source = readBoundedFile(path, maximumBytes, message);
  let value;
  try {
    value = JSON.parse(source);
  } catch (error) {
    throw new NativeImageSmokeError(message, { cause: error });
  }
  if (requireCanonical && source !== canonicalJson(value)) {
    fail('A native host evidence file must be canonical JSON.');
  }
  return { source, value };
}

function readBoundedFile(path, maximumBytes, message) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) {
    fail(message);
  }
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size > maximumBytes
    ) {
      fail(message);
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof NativeImageSmokeError) throw error;
    throw new NativeImageSmokeError(message, { cause: error });
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

function supportedPlatform(value) {
  if (!PLATFORMS.includes(value)) {
    fail('The native smoke platform must be linux/amd64 or linux/arm64.');
  }
  return value;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    fail(`The ${name} must be canonical millisecond UTC.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    fail(`The ${name} must be canonical millisecond UTC.`);
  }
  return parsed;
}

function validDate(value, name) {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    fail(`The ${name} is invalid.`);
  }
  return value;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareAscii)
        .map((key) => [key, sortJson(value[key])])
    );
  }
  return value;
}

function compareSmokeRecords(left, right) {
  return (
    compareAscii(left.target, right.target) ||
    PLATFORMS.indexOf(left.platform) - PLATFORMS.indexOf(right.platform)
  );
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function fail(message) {
  throw new NativeImageSmokeError(message);
}
