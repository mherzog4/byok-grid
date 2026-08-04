import { lstatSync, readFileSync } from 'node:fs';

import { createGhcrTagInspector } from './publish-release-image-tags-lib.mjs';
import {
  createGitHubApiReader,
  readLiveReleaseProtectionState,
  releaseProtectionRecordsFromManifest,
  ReleaseProtectionError,
  verifyReleaseProtection,
  writeReleaseProtectionEvidence,
} from './verify-release-protection-lib.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  const releaseConfig = readReleaseConfig();
  const manifest = releaseProtectionRecordsFromManifest({
    source: readDigestManifest(options.digestManifest),
    owner: options.owner,
    releaseConfig,
    version: options.version,
  });
  const readGitHub = createGitHubApiReader({
    token: process.env.BYOK_GRID_GITHUB_TOKEN,
  });
  const state = await readLiveReleaseProtectionState({
    readGitHub,
    repository: options.repository,
    version: options.version,
  });
  const inspectTag = createGhcrTagInspector({
    actor: process.env.BYOK_GRID_GHCR_ACTOR,
    token: process.env.BYOK_GRID_GHCR_TOKEN,
  });
  const result = await verifyReleaseProtection({
    ...state,
    candidate: options.candidate,
    digestManifestSha256: manifest.digestManifestSha256,
    inspectTag,
    records: manifest.records,
    repository: options.repository,
    version: options.version,
  });
  writeReleaseProtectionEvidence(options.output, result);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message =
    error instanceof ReleaseProtectionError ||
    error?.name === 'ReleaseImageTagsError'
      ? error.message
      : 'Release protection verification failed unexpectedly.';
  process.stderr.write(`Release protection verification failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const flags = new Map([
    ['--candidate', 'candidate'],
    ['--digest-manifest', 'digestManifest'],
    ['--output', 'output'],
    ['--owner', 'owner'],
    ['--repository', 'repository'],
    ['--version', 'version'],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = flags.get(flag);
    if (!key || !value || options[key]) {
      throw new ReleaseProtectionError(usage());
    }
    options[key] = value;
  }
  if (
    args.length !== flags.size * 2 ||
    Object.keys(options).length !== flags.size
  ) {
    throw new ReleaseProtectionError(usage());
  }
  if (options.owner !== options.repository.split('/')[0]) {
    throw new ReleaseProtectionError(
      'The GHCR owner must match the repository owner.'
    );
  }
  if (options.output.length > 4_096) {
    throw new ReleaseProtectionError('The evidence output path is invalid.');
  }
  return options;
}

function readReleaseConfig() {
  try {
    return JSON.parse(readFileSync('release-images.json', 'utf8'));
  } catch (error) {
    throw new ReleaseProtectionError(
      'The release image configuration could not be read.',
      { cause: error }
    );
  }
}

function readDigestManifest(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new ReleaseProtectionError('IMAGE_DIGESTS.txt is unavailable.', {
      cause: error,
    });
  }
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size === 0 ||
    metadata.size > 16_384
  ) {
    throw new ReleaseProtectionError(
      'IMAGE_DIGESTS.txt must be a bounded regular file.'
    );
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new ReleaseProtectionError('IMAGE_DIGESTS.txt could not be read.', {
      cause: error,
    });
  }
}

function usage() {
  return 'Usage: verify-release-protection --version VERSION --candidate SHA --digest-manifest IMAGE_DIGESTS.txt --owner OWNER --repository OWNER/REPOSITORY --output FILE';
}
