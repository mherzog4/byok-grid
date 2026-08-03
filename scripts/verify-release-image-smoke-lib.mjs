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
    parsed.target !== expectedTarget
  ) {
    fail(
      'The image smoke response does not match the expected release target.'
    );
  }

  return {
    digest: options.expectedDigest,
    marker: RELEASE_IMAGE_SMOKE_MARKER,
    platform: options.expectedPlatform,
    target: expectedTarget,
  };
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
