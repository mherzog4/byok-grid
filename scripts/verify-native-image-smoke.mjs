import { writeFileSync } from 'node:fs';

import {
  NativeImageSmokeError,
  canonicalJson,
  verifyNativeImageSmokeBundleFiles,
} from './native-image-smoke-lib.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  const evidence = verifyNativeImageSmokeBundleFiles(options);
  writeEvidence(options.outputPath, evidence);
  process.stdout.write(
    `${JSON.stringify({
      hosts: evidence.hostEvidence.length,
      marker: evidence.marker,
      records: evidence.records,
      releaseVersion: evidence.releaseVersion,
    })}\n`
  );
} catch (error) {
  const message =
    error instanceof NativeImageSmokeError
      ? error.message
      : 'Native multi-architecture evidence verification failed unexpectedly.';
  process.stderr.write(
    `Native multi-architecture evidence verification failed: ${message}\n`
  );
  process.exitCode = 1;
}

function parseArguments(args) {
  const allowed = new Map([
    ['--version', 'releaseVersion'],
    ['--candidate', 'candidateCommit'],
    ['--digest-manifest', 'digestManifestPath'],
    ['--release-smoke', 'releaseSmokeManifestPath'],
    ['--amd64-evidence', 'amd64EvidencePath'],
    ['--arm64-evidence', 'arm64EvidencePath'],
    ['--output', 'outputPath'],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = allowed.get(flag);
    if (!key || !value || options[key]) {
      throw new NativeImageSmokeError(
        'Expected unique release, manifest, native-host, and output arguments.'
      );
    }
    options[key] = value;
  }
  if (args.length !== allowed.size * 2 || Object.keys(options).length !== 7) {
    throw new NativeImageSmokeError(
      'Expected unique release, manifest, native-host, and output arguments.'
    );
  }
  return options;
}

function writeEvidence(path, evidence) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) {
    throw new NativeImageSmokeError(
      'The combined native evidence output path is invalid.'
    );
  }
  try {
    writeFileSync(path, canonicalJson(evidence), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    throw new NativeImageSmokeError(
      'The combined native evidence file could not be created.',
      { cause: error }
    );
  }
}
