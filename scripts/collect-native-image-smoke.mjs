import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';

import {
  NativeImageSmokeError,
  canonicalJson,
  collectNativeImageSmokeEvidence,
  runtimePlatform,
} from './native-image-smoke-lib.mjs';

try {
  const options = parseArguments(process.argv.slice(2));
  verifyCandidateCheckout(options.candidateCommit);
  const digestManifest = readInput(
    options.digestManifestPath,
    65_536,
    'The image digest manifest could not be read.'
  );
  const releaseConfig = JSON.parse(
    readInput(
      'release-images.json',
      65_536,
      'The release image configuration could not be read.'
    )
  );
  const evidence = collectNativeImageSmokeEvidence({
    candidateCommit: options.candidateCommit,
    digestManifest,
    hostPlatform: runtimePlatform(),
    releaseConfig,
    releaseVersion: options.releaseVersion,
    runCommand: runDocker,
  });
  writeEvidence(options.outputPath, evidence);
  process.stdout.write(
    `${JSON.stringify({
      images: evidence.records.length,
      marker: evidence.marker,
      platform: evidence.platform,
      releaseVersion: evidence.releaseVersion,
    })}\n`
  );
} catch (error) {
  const message =
    error instanceof NativeImageSmokeError
      ? error.message
      : 'Native image smoke collection failed unexpectedly.';
  process.stderr.write(`Native image smoke collection failed: ${message}\n`);
  process.exitCode = 1;
}

function parseArguments(args) {
  const allowed = new Map([
    ['--version', 'releaseVersion'],
    ['--candidate', 'candidateCommit'],
    ['--digest-manifest', 'digestManifestPath'],
    ['--output', 'outputPath'],
  ]);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    const key = allowed.get(flag);
    if (!key || !value || options[key]) {
      throw new NativeImageSmokeError(
        'Expected unique version, candidate, digest-manifest, and output arguments.'
      );
    }
    options[key] = value;
  }
  if (args.length !== allowed.size * 2 || Object.keys(options).length !== 4) {
    throw new NativeImageSmokeError(
      'Expected unique version, candidate, digest-manifest, and output arguments.'
    );
  }
  return options;
}

function runDocker(command, args, { timeout }) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 65_536,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout,
  });
  return {
    status: result.error ? null : result.status,
    stdout: result.stdout ?? '',
  };
}

function verifyCandidateCheckout(candidateCommit) {
  if (!/^[0-9a-f]{40}$/u.test(candidateCommit)) {
    throw new NativeImageSmokeError(
      'The candidate commit must be a lowercase 40-character SHA.'
    );
  }
  const head = runGit(['rev-parse', 'HEAD']);
  const status = runGit(['status', '--porcelain=v1', '--untracked-files=all']);
  if (head.trim() !== candidateCommit || status.length !== 0) {
    throw new NativeImageSmokeError(
      'Native image smoke collection requires the exact clean candidate checkout.'
    );
  }
}

function runGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 65_536,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15_000,
  });
  if (
    result.error ||
    result.status !== 0 ||
    typeof result.stdout !== 'string' ||
    Buffer.byteLength(result.stdout) > 65_536
  ) {
    throw new NativeImageSmokeError(
      'The candidate checkout identity could not be verified.'
    );
  }
  return result.stdout;
}

function readInput(path, maximumBytes, message) {
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size > maximumBytes
    ) {
      throw new NativeImageSmokeError(message);
    }
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof NativeImageSmokeError) throw error;
    throw new NativeImageSmokeError(message, { cause: error });
  }
}

function writeEvidence(path, evidence) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4_096) {
    throw new NativeImageSmokeError(
      'The native host evidence output path is invalid.'
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
      'The native host evidence file could not be created.',
      { cause: error }
    );
  }
}
