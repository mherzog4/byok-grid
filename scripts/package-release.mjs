import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateHelmDigestValues } from './generate-helm-digest-values.mjs';
import {
  verifyReleaseImageSmokeEvidence,
  verifyReleaseImageSmokeManifest,
} from './verify-release-image-smoke-lib.mjs';

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const smokePlatforms = Object.freeze(['linux/amd64', 'linux/arm64']);
const reproducibleTimestamp = new Date('1985-10-26T08:15:00.000Z');

export function collectReleaseDigests(digestsDirectory, releaseConfig) {
  const entries = validateReleaseConfig(releaseConfig);
  const expectedFiles = new Set(entries.map(({ target }) => `${target}.txt`));
  const actualFiles = readdirSync(digestsDirectory);

  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) {
      throw new Error(`Unexpected digest artifact ${file}.`);
    }
  }

  const records = [];
  for (const { image, target } of entries) {
    const file = `${target}.txt`;
    if (!actualFiles.includes(file)) {
      throw new Error(`Missing digest artifact ${file}.`);
    }
    const path = join(digestsDirectory, file);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size > 4_096) {
      throw new Error(`Digest artifact ${file} must be a bounded file.`);
    }
    const reference = readFileSync(path, 'utf8').trim();
    const pattern = new RegExp(
      `^ghcr\\.io\\/[A-Za-z0-9._-]+\\/${escapeRegex(image)}@sha256:[0-9a-f]{64}$`
    );
    if (!pattern.test(reference)) {
      throw new Error(`Digest artifact ${file} does not reference ${image}.`);
    }
    records.push(reference);
  }

  return `${records.sort().join('\n')}\n`;
}

export function collectReleaseSmokeEvidence(
  smokeDirectory,
  digestManifest,
  releaseConfig
) {
  const entries = validateReleaseConfig(releaseConfig);
  const releaseTargets = entries.map(({ target }) => target);
  const expectedFiles = new Set(entries.map(({ target }) => `${target}.jsonl`));
  const actualFiles = readdirSync(smokeDirectory);

  for (const file of actualFiles) {
    if (!expectedFiles.has(file)) {
      throw new Error(`Unexpected image smoke artifact ${file}.`);
    }
  }

  const digests = releaseDigestTargets(digestManifest, releaseConfig);
  const records = [];
  for (const { target } of entries) {
    const file = `${target}.jsonl`;
    if (!actualFiles.includes(file)) {
      throw new Error(`Missing image smoke artifact ${file}.`);
    }
    const path = join(smokeDirectory, file);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.size > 16_384) {
      throw new Error(`Image smoke artifact ${file} must be a bounded file.`);
    }
    const source = readFileSync(path, 'utf8');
    if (!source.endsWith('\n')) {
      throw new Error(`Image smoke artifact ${file} must end with a newline.`);
    }
    const lines = source.slice(0, -1).split('\n');
    if (
      lines.length !== smokePlatforms.length ||
      lines.some((line) => line.length === 0 || line.includes('\r'))
    ) {
      throw new Error(
        `Image smoke artifact ${file} must contain exactly two JSONL records.`
      );
    }

    const platforms = new Set();
    for (const line of lines) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Image smoke artifact ${file} contains invalid JSON.`);
      }
      const platform = parsed?.platform;
      const verified = verifyReleaseImageSmokeEvidence(parsed, {
        expectedDigest: digests.get(target),
        expectedPlatform: platform,
        expectedTarget: target,
        releaseTargets,
      });
      if (platforms.has(platform)) {
        throw new Error(`Image smoke artifact ${file} repeats ${platform}.`);
      }
      platforms.add(platform);
      records.push(verified);
    }
    if (smokePlatforms.some((platform) => !platforms.has(platform))) {
      throw new Error(`Image smoke artifact ${file} is missing a platform.`);
    }
  }

  records.sort(
    (left, right) =>
      compareAscii(left.target, right.target) ||
      smokePlatforms.indexOf(left.platform) -
        smokePlatforms.indexOf(right.platform)
  );
  const manifest = `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
  verifyReleaseImageSmokeManifest(manifest, {
    expectedImages: entries.map(({ target }) => ({
      digest: digests.get(target),
      target,
    })),
  });
  return manifest;
}

export function createChecksumManifest(directory) {
  const files = readdirSync(directory)
    .filter((name) => name !== 'SHA256SUMS')
    .sort();

  if (files.length === 0) {
    throw new Error('Cannot checksum an empty release directory.');
  }

  return `${files
    .map((name) => {
      const path = join(directory, name);
      if (!lstatSync(path).isFile()) {
        throw new Error(`Release artifact ${name} is not a regular file.`);
      }
      const digest = createHash('sha256')
        .update(readFileSync(path))
        .digest('hex');
      return `${digest}  ${name}`;
    })
    .join('\n')}\n`;
}

export function packageRelease({
  version,
  digestsDirectory,
  smokeDirectory,
  outputDirectory,
  rootDirectory = process.cwd(),
  runCommand = runExternalCommand,
}) {
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid release version ${JSON.stringify(version)}.`);
  }

  const root = resolve(rootDirectory);
  const digests = resolve(root, digestsDirectory);
  const smoke = resolve(root, smokeDirectory);
  const output = resolve(root, outputDirectory);
  if (existsSync(output)) {
    throw new Error(`Release output already exists: ${output}`);
  }

  const parent = dirname(output);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${basename(output)}.tmp-`));
  let npmCache;
  let chartCopy;

  try {
    npmCache = mkdtempSync(join(parent, `.${basename(output)}.npm-cache.tmp-`));
    const releaseConfig = JSON.parse(
      readFileSync(join(root, 'release-images.json'), 'utf8')
    );
    const digestManifest = collectReleaseDigests(digests, releaseConfig);
    writeFileSync(join(staging, 'IMAGE_DIGESTS.txt'), digestManifest, 'utf8');
    writeFileSync(
      join(staging, 'IMAGE_SMOKE.jsonl'),
      collectReleaseSmokeEvidence(smoke, digestManifest, releaseConfig),
      'utf8'
    );
    writeFileSync(
      join(staging, 'values.digests.yaml'),
      generateHelmDigestValues(digestManifest, releaseConfig),
      'utf8'
    );

    chartCopy = mkdtempSync(join(parent, `.${basename(output)}.chart.tmp-`));
    const reproducibleChart = join(chartCopy, 'byok-grid');
    copyReproducibleChart(
      join(root, 'deploy/helm/byok-grid'),
      reproducibleChart
    );
    runCommand(
      'helm',
      [
        'package',
        reproducibleChart,
        '--destination',
        staging,
        '--version',
        version,
        '--app-version',
        version,
      ],
      root
    );
    rmSync(chartCopy, { force: true, recursive: true });
    chartCopy = undefined;
    runCommand(
      'npm',
      [
        '--cache',
        npmCache,
        'pack',
        '--workspace=@byok-grid/connector-sdk',
        '--pack-destination',
        staging,
      ],
      root
    );
    rmSync(npmCache, { force: true, recursive: true });
    npmCache = undefined;

    requireArtifact(staging, `byok-grid-${version}.tgz`);
    const sdkPackages = readdirSync(staging).filter((name) =>
      /^byok-grid-connector-sdk-[0-9].*\.tgz$/.test(name)
    );
    if (sdkPackages.length !== 1) {
      throw new Error('Expected exactly one connector SDK package.');
    }

    writeFileSync(
      join(staging, 'SHA256SUMS'),
      createChecksumManifest(staging),
      'utf8'
    );
    renameSync(staging, output);
    return output;
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  } finally {
    if (chartCopy) rmSync(chartCopy, { force: true, recursive: true });
    if (npmCache) rmSync(npmCache, { force: true, recursive: true });
  }
}

export function copyReproducibleChart(sourceDirectory, targetDirectory) {
  const source = resolve(sourceDirectory);
  const target = resolve(targetDirectory);
  const sourceMetadata = lstatSync(source);
  if (!sourceMetadata.isDirectory() || sourceMetadata.isSymbolicLink()) {
    throw new Error('The release chart source must be a real directory.');
  }
  copyReproducibleDirectory(source, target);
}

function copyReproducibleDirectory(source, target) {
  const metadata = lstatSync(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The release chart may contain only real directories.');
  }
  mkdirSync(target, { mode: metadata.mode & 0o777 });
  const names = readdirSync(source).sort(compareAscii);
  for (const name of names) {
    const sourcePath = join(source, name);
    const targetPath = join(target, name);
    const entry = lstatSync(sourcePath);
    if (entry.isSymbolicLink()) {
      throw new Error('The release chart must not contain symbolic links.');
    }
    if (entry.isDirectory()) {
      copyReproducibleDirectory(sourcePath, targetPath);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error('The release chart may contain only regular files.');
    }
    copyFileSync(sourcePath, targetPath);
    chmodSync(targetPath, entry.mode & 0o777);
    utimesSync(targetPath, reproducibleTimestamp, reproducibleTimestamp);
  }
  chmodSync(target, metadata.mode & 0o777);
  utimesSync(target, reproducibleTimestamp, reproducibleTimestamp);
}

function validateReleaseConfig(config) {
  if (config?.schemaVersion !== 1 || !Array.isArray(config.images)) {
    throw new Error('release-images.json must use schemaVersion 1.');
  }
  const targets = new Set();
  const images = new Set();
  return config.images.map((entry) => {
    if (
      typeof entry?.target !== 'string' ||
      typeof entry?.image !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(entry.target) ||
      !/^byok-grid-[a-z0-9-]+$/.test(entry.image) ||
      targets.has(entry.target) ||
      images.has(entry.image)
    ) {
      throw new Error(
        'Release image targets and names must be safe and unique.'
      );
    }
    targets.add(entry.target);
    images.add(entry.image);
    return { target: entry.target, image: entry.image };
  });
}

export function releaseDigestTargets(manifest, releaseConfig) {
  const entries = validateReleaseConfig(releaseConfig);
  if (typeof manifest !== 'string' || Buffer.byteLength(manifest) > 16_384) {
    throw new Error('Image digest manifest must be bounded text.');
  }
  const targetsByImage = new Map(
    entries.map(({ image, target }) => [image, target])
  );
  const digests = new Map();
  const lines = manifest
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(
      /^ghcr\.io\/[A-Za-z0-9._-]+\/(?<image>byok-grid-[a-z0-9-]+)@(?<digest>sha256:[0-9a-f]{64})$/u
    );
    const target = match?.groups
      ? targetsByImage.get(match.groups.image)
      : undefined;
    if (!match?.groups || !target || digests.has(target)) {
      throw new Error('Image digest manifest does not match the release set.');
    }
    digests.set(target, match.groups.digest);
  }
  if (
    digests.size !== entries.length ||
    entries.some(({ target }) => !digests.has(target))
  ) {
    throw new Error('Image digest manifest is incomplete.');
  }
  return digests;
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireArtifact(directory, name) {
  const path = join(directory, name);
  if (!existsSync(path) || !lstatSync(path).isFile()) {
    throw new Error(`Expected release artifact ${name}.`);
  }
}

function runExternalCommand(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}.`);
  }
}

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith('--') || !value || values.has(key)) {
      throw new Error('Expected unique --name value arguments.');
    }
    values.set(key, value);
  }
  const allowed = new Set([
    '--version',
    '--digests-dir',
    '--smoke-dir',
    '--output-dir',
  ]);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown argument ${key}.`);
  }
  for (const key of allowed) {
    if (!values.has(key)) throw new Error(`Missing required argument ${key}.`);
  }
  return {
    version: values.get('--version'),
    digestsDirectory: values.get('--digests-dir'),
    smokeDirectory: values.get('--smoke-dir'),
    outputDirectory: values.get('--output-dir'),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const output = packageRelease(parseArguments(process.argv.slice(2)));
    console.log(`Release artifacts assembled atomically in ${output}.`);
  } catch (error) {
    console.error(
      `Failed to package release: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
