import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ReleaseBundleError,
  verifyReleaseBundle,
} from './verify-release-bundle-lib.mjs';

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || values.has(key)) {
      throw new ReleaseBundleError(
        'Expected unique --version and --directory arguments.'
      );
    }
    values.set(key, value);
  }
  const allowed = new Set(['--version', '--directory']);
  for (const key of values.keys()) {
    if (!allowed.has(key)) {
      throw new ReleaseBundleError('The release bundle argument is unknown.');
    }
  }
  for (const key of allowed) {
    if (!values.has(key)) {
      throw new ReleaseBundleError('A release bundle argument is missing.');
    }
  }
  return {
    directory: values.get('--directory'),
    version: values.get('--version'),
  };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const verified = await verifyReleaseBundle(
      parseArguments(process.argv.slice(2))
    );
    process.stdout.write(`${JSON.stringify(verified)}\n`);
  } catch (error) {
    const message =
      error instanceof ReleaseBundleError
        ? error.message
        : 'Release bundle verification failed unexpectedly.';
    process.stderr.write(`Release bundle verification failed: ${message}\n`);
    process.exit(1);
  }
}
