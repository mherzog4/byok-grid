import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PublishedReleaseError,
  verifyPublishedRelease,
} from './verify-published-release-lib.mjs';

const MAX_RELEASE_RESPONSE_BYTES = 1_048_576;
const MAX_RELEASE_NOTES_BYTES = 262_144;

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || values.has(key)) {
      throw new PublishedReleaseError(
        'Expected unique --version, --directory, --release-json, and --notes-file arguments.'
      );
    }
    values.set(key, value);
  }
  const allowed = new Set([
    '--version',
    '--directory',
    '--release-json',
    '--notes-file',
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new PublishedReleaseError(
        'The published release argument is unknown.'
      );
    }
  }
  for (const key of allowed) {
    if (!values.has(key)) {
      throw new PublishedReleaseError(
        'A published release argument is missing.'
      );
    }
  }
  return {
    directory: values.get('--directory'),
    notesFile: values.get('--notes-file'),
    releaseJson: values.get('--release-json'),
    version: values.get('--version'),
  };
}

function readReleaseNotes(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new PublishedReleaseError(
      'The reviewed release notes are unavailable.',
      {
        cause: error,
      }
    );
  }
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > MAX_RELEASE_NOTES_BYTES
  ) {
    throw new PublishedReleaseError(
      'The reviewed release notes must be a bounded regular file.'
    );
  }
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new PublishedReleaseError(
      'The reviewed release notes could not be read.',
      {
        cause: error,
      }
    );
  }
}

function readReleaseResponse(path) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    throw new PublishedReleaseError(
      'The GitHub release response is unavailable.',
      { cause: error }
    );
  }
  if (
    !metadata.isFile() ||
    metadata.size === 0 ||
    metadata.size > MAX_RELEASE_RESPONSE_BYTES
  ) {
    throw new PublishedReleaseError(
      'The GitHub release response must be a bounded regular file.'
    );
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new PublishedReleaseError(
      'The GitHub release response is not valid JSON.',
      { cause: error }
    );
  }
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const verified = await verifyPublishedRelease({
      directory: options.directory,
      release: readReleaseResponse(options.releaseJson),
      releaseNotes: readReleaseNotes(options.notesFile),
      version: options.version,
    });
    process.stdout.write(`${JSON.stringify(verified)}\n`);
  } catch (error) {
    const message =
      error instanceof PublishedReleaseError
        ? error.message
        : 'Published release verification failed unexpectedly.';
    process.stderr.write(`Published release verification failed: ${message}\n`);
    process.exit(1);
  }
}
