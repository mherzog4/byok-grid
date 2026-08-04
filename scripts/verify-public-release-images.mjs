import { readFileSync } from 'node:fs';

import { readReleaseImageTagInputs } from './publish-release-image-tags-lib.mjs';
import {
  createAnonymousGhcrTagInspector,
  PublicReleaseImagesError,
  verifyPublicReleaseImages,
} from './verify-public-release-images-lib.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  const records = readReleaseImageTagInputs({
    digestsDirectory: options.digestsDirectory,
    owner: options.owner,
    releaseConfig: readReleaseConfig(),
    version: options.version,
  });
  const result = await verifyPublicReleaseImages({
    inspectPublicTag: createAnonymousGhcrTagInspector(),
    records,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message =
    error instanceof PublicReleaseImagesError ||
    error?.name === 'ReleaseImageTagsError'
      ? error.message
      : 'Public release image verification failed unexpectedly.';
  process.stderr.write(
    `Public release image verification failed: ${message}\n`
  );
  process.exitCode = 1;
}

function parseArguments(args) {
  const flags = new Map([
    ['--digests-dir', 'digestsDirectory'],
    ['--owner', 'owner'],
    ['--version', 'version'],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = flags.get(args[index]);
    const value = args[index + 1];
    if (!key || !value || options[key]) {
      throw new PublicReleaseImagesError(usage());
    }
    options[key] = value;
  }
  if (
    args.length !== flags.size * 2 ||
    Object.keys(options).length !== flags.size
  ) {
    throw new PublicReleaseImagesError(usage());
  }
  return options;
}

function readReleaseConfig() {
  try {
    return JSON.parse(readFileSync('release-images.json', 'utf8'));
  } catch (error) {
    throw new PublicReleaseImagesError(
      'The release image configuration could not be read.',
      { cause: error }
    );
  }
}

function usage() {
  return 'Usage: verify-public-release-images --version VERSION --digests-dir DIRECTORY --owner OWNER';
}
