import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  ReleaseImageTagsError,
  createGhcrTagInspector,
  publishReleaseImageTags,
  readReleaseImageTagInputs,
} from './publish-release-image-tags-lib.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  const releaseConfig = JSON.parse(readFileSync('release-images.json', 'utf8'));
  const records = readReleaseImageTagInputs({
    digestsDirectory: options.digestsDirectory,
    owner: options.owner,
    releaseConfig,
    version: options.version,
  });
  const inspectTag = createGhcrTagInspector({
    actor: process.env.BYOK_GRID_GHCR_ACTOR,
    token: process.env.BYOK_GRID_GHCR_TOKEN,
  });
  const result = await publishReleaseImageTags({
    inspectTag,
    publishTag: publishWithBuildx,
    records,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message =
    error instanceof ReleaseImageTagsError
      ? error.message
      : 'Release image tags could not be safely published.';
  process.stderr.write(`Failed to publish release image tags: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !['--version', '--digests-dir', '--owner'].includes(flag)) {
      throw new ReleaseImageTagsError(
        'Usage: publish-release-image-tags --version VERSION --digests-dir DIRECTORY --owner OWNER'
      );
    }
    const key = {
      '--digests-dir': 'digestsDirectory',
      '--owner': 'owner',
      '--version': 'version',
    }[flag];
    if (options[key]) {
      throw new ReleaseImageTagsError('Release image options must be unique.');
    }
    options[key] = value;
  }
  if (
    args.length !== 6 ||
    !options.version ||
    !options.digestsDirectory ||
    !options.owner
  ) {
    throw new ReleaseImageTagsError(
      'Usage: publish-release-image-tags --version VERSION --digests-dir DIRECTORY --owner OWNER'
    );
  }
  return options;
}

function publishWithBuildx(record) {
  const result = spawnSync(
    'docker',
    [
      'buildx',
      'imagetools',
      'create',
      '--tag',
      record.destination,
      record.source,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1_048_576,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    }
  );
  if (result.error || result.status !== 0) {
    throw new ReleaseImageTagsError(
      'Docker Buildx could not publish a release image version tag.'
    );
  }
}
