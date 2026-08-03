import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateHelmDigestValues } from './generate-helm-digest-values.mjs';

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?$/;

export function collectReleaseDigests(digestsDirectory, releaseConfig) {
  const entries = validateReleaseConfig(releaseConfig);
  const expectedFiles = new Set(entries.map(({ target }) => `${target}.txt`));
  const actualFiles = readdirSync(digestsDirectory).filter(
    (name) => !name.startsWith('.')
  );

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
    const reference = readFileSync(join(digestsDirectory, file), 'utf8').trim();
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
  outputDirectory,
  rootDirectory = process.cwd(),
  runCommand = runExternalCommand,
}) {
  if (!semverPattern.test(version)) {
    throw new Error(`Invalid release version ${JSON.stringify(version)}.`);
  }

  const root = resolve(rootDirectory);
  const digests = resolve(root, digestsDirectory);
  const output = resolve(root, outputDirectory);
  if (existsSync(output)) {
    throw new Error(`Release output already exists: ${output}`);
  }

  const parent = dirname(output);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${basename(output)}.tmp-`));

  try {
    const releaseConfig = JSON.parse(
      readFileSync(join(root, 'release-images.json'), 'utf8')
    );
    const digestManifest = collectReleaseDigests(digests, releaseConfig);
    writeFileSync(join(staging, 'IMAGE_DIGESTS.txt'), digestManifest, 'utf8');
    writeFileSync(
      join(staging, 'values.digests.yaml'),
      generateHelmDigestValues(digestManifest, releaseConfig),
      'utf8'
    );

    runCommand(
      'helm',
      [
        'package',
        'deploy/helm/byok-grid',
        '--destination',
        staging,
        '--version',
        version,
        '--app-version',
        version,
      ],
      root
    );
    runCommand(
      'npm',
      [
        'pack',
        '--workspace=@byok-grid/connector-sdk',
        '--pack-destination',
        staging,
      ],
      root
    );

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
  }
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
  const allowed = new Set(['--version', '--digests-dir', '--output-dir']);
  for (const key of values.keys()) {
    if (!allowed.has(key)) throw new Error(`Unknown argument ${key}.`);
  }
  for (const key of allowed) {
    if (!values.has(key)) throw new Error(`Missing required argument ${key}.`);
  }
  return {
    version: values.get('--version'),
    digestsDirectory: values.get('--digests-dir'),
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
