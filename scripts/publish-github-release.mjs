import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  GitHubReleasePublicationError,
  createGitHubReleaseInspector,
  publishGitHubRelease,
} from './publish-github-release-lib.mjs';

const MAX_RELEASE_NOTES_BYTES = 262_144;

try {
  const options = parseArguments(process.argv.slice(2));
  const releaseNotes = readReleaseNotes(options.notesFile);
  const assetPaths = readAssetPaths(options.directory);
  const inspectRelease = createGitHubReleaseInspector({
    repository: options.repository,
    token: process.env.GH_TOKEN,
    version: options.version,
  });
  const published = await publishGitHubRelease({
    createRelease: () => createRelease({ ...options, assetPaths }),
    directory: options.directory,
    inspectRelease,
    releaseNotes,
    version: options.version,
  });
  writeReleaseResponse(options.releaseJson, published.release);
  const { release: _release, ...result } = published;
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message =
    error instanceof GitHubReleasePublicationError
      ? error.message
      : 'GitHub Release publication failed unexpectedly.';
  process.stderr.write(`GitHub Release publication failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const allowed = new Map([
    ['--version', 'version'],
    ['--directory', 'directory'],
    ['--notes-file', 'notesFile'],
    ['--release-json', 'releaseJson'],
    ['--repository', 'repository'],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = allowed.get(flag);
    if (!key || !value || options[key]) {
      throw new GitHubReleasePublicationError(
        'Expected unique release version, directory, notes, response, and repository arguments.'
      );
    }
    options[key] = value;
  }
  if (args.length !== allowed.size * 2 || Object.keys(options).length !== 5) {
    throw new GitHubReleasePublicationError(
      'Expected unique release version, directory, notes, response, and repository arguments.'
    );
  }
  return options;
}

function readReleaseNotes(path) {
  const metadata = safeMetadata(
    path,
    'The reviewed release notes are unavailable.'
  );
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > MAX_RELEASE_NOTES_BYTES
  ) {
    throw new GitHubReleasePublicationError(
      'The reviewed release notes must be a bounded regular file.'
    );
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new GitHubReleasePublicationError(
      'The reviewed release notes could not be read.',
      { cause: error }
    );
  }
}

function readAssetPaths(directory) {
  const root = resolve(directory);
  const metadata = safeMetadata(
    root,
    'The local release bundle is unavailable.'
  );
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new GitHubReleasePublicationError(
      'The local release bundle must be a real directory.'
    );
  }
  let names;
  try {
    names = readdirSync(root).sort(compareAscii);
  } catch (error) {
    throw new GitHubReleasePublicationError(
      'The local release bundle could not be read.',
      { cause: error }
    );
  }
  if (names.length !== 6) {
    throw new GitHubReleasePublicationError(
      'The local release bundle must contain exactly six assets.'
    );
  }
  return names.map((name) => join(root, name));
}

function createRelease({
  version,
  directory: _directory,
  notesFile,
  releaseJson: _releaseJson,
  repository,
  assetPaths,
}) {
  const args = [
    'release',
    'create',
    `v${version}`,
    ...assetPaths,
    '--repo',
    repository,
    '--verify-tag',
    '--notes-file',
    notesFile,
    '--title',
    `BYOK Grid ${version}`,
  ];
  if (version.includes('-')) {
    args.push('--prerelease', '--latest=false');
  } else {
    args.push('--latest');
  }
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 1_048_576,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new GitHubReleasePublicationError(
      'The GitHub CLI could not create the release.'
    );
  }
}

function writeReleaseResponse(path, release) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) {
    throw new GitHubReleasePublicationError(
      'The GitHub release response path is invalid.'
    );
  }
  try {
    writeFileSync(path, `${JSON.stringify(release)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    throw new GitHubReleasePublicationError(
      'The verified GitHub release response could not be recorded.',
      { cause: error }
    );
  }
}

function safeMetadata(path, message) {
  try {
    return lstatSync(path);
  } catch (error) {
    throw new GitHubReleasePublicationError(message, { cause: error });
  }
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
