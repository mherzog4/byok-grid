export const IMAGE_SMOKE_READY_MARKER = 'BYOK_GRID_IMAGE_SMOKE_READY';
export const RELEASE_IMAGE_SMOKE_MARKER =
  'BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED';

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TARGET_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const PLATFORMS = Object.freeze(['linux/amd64', 'linux/arm64']);

export class ReleaseImageSmokeError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'ReleaseImageSmokeError';
  }
}

export function verifyReleaseImageSmoke(raw, options) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 4_096) {
    fail('The image smoke response must be bounded text.');
  }
  const expected = validateExpectedSmoke(options);

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ReleaseImageSmokeError(
      'The image smoke response must be valid JSON.',
      { cause: error }
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('The image smoke response must be an object.');
  }
  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== 'marker' || keys[1] !== 'target') {
    fail('The image smoke response contains missing or unexpected fields.');
  }
  if (
    parsed.marker !== IMAGE_SMOKE_READY_MARKER ||
    parsed.target !== expected.target
  ) {
    fail(
      'The image smoke response does not match the expected release target.'
    );
  }

  return evidenceRecord(expected);
}

export function verifyReleaseImageSmokeEvidence(value, options) {
  const expected = validateExpectedSmoke(options);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('The release image smoke evidence must be an object.');
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== 'digest' ||
    keys[1] !== 'marker' ||
    keys[2] !== 'platform' ||
    keys[3] !== 'target'
  ) {
    fail('The release image smoke evidence has unexpected fields.');
  }
  if (
    value.digest !== expected.digest ||
    value.marker !== RELEASE_IMAGE_SMOKE_MARKER ||
    value.platform !== expected.platform ||
    value.target !== expected.target
  ) {
    fail('The release image smoke evidence does not match its release image.');
  }
  return evidenceRecord(expected);
}

export function verifyReleaseImageSmokeManifest(source, options) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 65_536) {
    fail('The release image smoke manifest must be bounded text.');
  }
  if (!source.endsWith('\n') || source.includes('\r')) {
    fail('The release image smoke manifest must be canonical JSONL.');
  }
  if (!options || !Array.isArray(options.expectedImages)) {
    fail('The release image smoke manifest needs expected images.');
  }

  const expectedImages = new Map();
  for (const entry of options.expectedImages) {
    const expectedTarget = target(entry?.target, 'manifest target');
    if (
      typeof entry?.digest !== 'string' ||
      !DIGEST_PATTERN.test(entry.digest) ||
      expectedImages.has(expectedTarget)
    ) {
      fail('The release image smoke manifest images must be safe and unique.');
    }
    expectedImages.set(expectedTarget, entry.digest);
  }
  if (expectedImages.size === 0) {
    fail('The release image smoke manifest needs expected images.');
  }

  const releaseTargets = [...expectedImages.keys()];
  const lines = source.slice(0, -1).split('\n');
  if (
    lines.length !== expectedImages.size * PLATFORMS.length ||
    lines.some((line) => line.length === 0)
  ) {
    fail('The release image smoke manifest has the wrong record count.');
  }

  const records = [];
  const identities = new Set();
  for (const line of lines) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail('The release image smoke manifest contains invalid JSON.');
    }
    const expectedDigest = expectedImages.get(parsed?.target);
    if (!expectedDigest) {
      fail('The release image smoke manifest contains an unknown target.');
    }
    const verified = verifyReleaseImageSmokeEvidence(parsed, {
      expectedDigest,
      expectedPlatform: parsed?.platform,
      expectedTarget: parsed?.target,
      releaseTargets,
    });
    const identity = `${verified.target}\u0000${verified.platform}`;
    if (identities.has(identity)) {
      fail('The release image smoke manifest repeats a target platform.');
    }
    identities.add(identity);
    records.push(verified);
  }

  for (const expectedTarget of releaseTargets) {
    for (const platform of PLATFORMS) {
      if (!identities.has(`${expectedTarget}\u0000${platform}`)) {
        fail('The release image smoke manifest is missing a target platform.');
      }
    }
  }

  records.sort(
    (left, right) =>
      compareAscii(left.target, right.target) ||
      PLATFORMS.indexOf(left.platform) - PLATFORMS.indexOf(right.platform)
  );
  const canonical = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  if (source !== canonical) {
    fail('The release image smoke manifest must be canonical JSONL.');
  }
  return records;
}

function validateExpectedSmoke(options) {
  if (
    !options ||
    typeof options !== 'object' ||
    !Array.isArray(options.releaseTargets)
  ) {
    fail('Image smoke verification needs the closed release target set.');
  }
  const expectedTarget = target(options.expectedTarget, 'expected target');
  const releaseTargets = options.releaseTargets.map((value) =>
    target(value, 'release target')
  );
  if (
    new Set(releaseTargets).size !== releaseTargets.length ||
    !releaseTargets.includes(expectedTarget)
  ) {
    fail('The expected image smoke target is not a unique release target.');
  }
  if (!PLATFORMS.includes(options.expectedPlatform)) {
    fail('The image smoke platform must be linux/amd64 or linux/arm64.');
  }
  if (
    typeof options.expectedDigest !== 'string' ||
    !DIGEST_PATTERN.test(options.expectedDigest)
  ) {
    fail('The image smoke digest must be a lowercase sha256 digest.');
  }
  return {
    digest: options.expectedDigest,
    platform: options.expectedPlatform,
    target: expectedTarget,
  };
}

function evidenceRecord(expected) {
  return {
    digest: expected.digest,
    marker: RELEASE_IMAGE_SMOKE_MARKER,
    platform: expected.platform,
    target: expected.target,
  };
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function target(value, name) {
  if (typeof value !== 'string' || !TARGET_PATTERN.test(value)) {
    fail(`The ${name} must be a safe release target.`);
  }
  return value;
}

function fail(message) {
  throw new ReleaseImageSmokeError(message);
}
