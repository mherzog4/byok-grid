import { readFileSync } from 'node:fs';
import process from 'node:process';
import {
  ReleaseImageSmokeError,
  verifyReleaseImageSmoke,
} from './verify-release-image-smoke-lib.mjs';

const [expectedTarget, expectedPlatform, expectedDigest] =
  process.argv.slice(2);

try {
  const releaseImages = JSON.parse(readFileSync('release-images.json', 'utf8'));
  if (
    releaseImages.schemaVersion !== 1 ||
    !Array.isArray(releaseImages.images)
  ) {
    throw new ReleaseImageSmokeError(
      'The release image configuration is malformed.'
    );
  }
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 4_096) {
      throw new ReleaseImageSmokeError(
        'The image smoke response must be bounded text.'
      );
    }
  }
  const verified = verifyReleaseImageSmoke(raw.trim(), {
    expectedDigest,
    expectedPlatform,
    expectedTarget,
    releaseTargets: releaseImages.images.map((image) => image?.target),
  });
  process.stdout.write(`${JSON.stringify(verified)}\n`);
} catch (error) {
  const message =
    error instanceof ReleaseImageSmokeError
      ? error.message
      : 'Release image smoke verification failed unexpectedly.';
  process.stderr.write(`Release image smoke verification failed: ${message}\n`);
  process.exit(1);
}
