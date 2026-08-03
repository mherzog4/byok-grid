import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const chartTargets = new Map([
  ['web', 'web'],
  ['workflow-worker', 'worker'],
  ['migration', 'migration'],
  ['connector-runner', 'connectorRunner'],
  ['analytics-projector', 'analyticsProjector'],
]);

export function generateHelmDigestValues(manifestSource, releaseConfig) {
  const expectedImages = validateReleaseConfig(releaseConfig);
  const records = parseDigestManifest(manifestSource);

  for (const [target, image] of expectedImages) {
    if (!records.has(image)) {
      throw new Error(`Digest manifest is missing ${target}/${image}.`);
    }
  }

  for (const image of records.keys()) {
    if (![...expectedImages.values()].includes(image)) {
      throw new Error(`Digest manifest contains unexpected image ${image}.`);
    }
  }

  const lines = [
    '# Generated from the attested IMAGE_DIGESTS.txt release asset.',
    '# Pass this file after operator values so immutable digests take precedence.',
  ];

  for (const [target, valuesKey] of chartTargets) {
    const image = expectedImages.get(target);
    if (!image) {
      throw new Error(
        `Release image configuration is missing chart target ${target}.`
      );
    }
    const record = records.get(image);
    lines.push(
      `${valuesKey}:`,
      '  image:',
      `    repository: '${record.repository}'`,
      "    tag: ''",
      `    digest: '${record.digest}'`
    );
  }

  return `${lines.join('\n')}\n`;
}

function parseDigestManifest(source) {
  const records = new Map();
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    const match = line.match(
      /^(?<repository>ghcr\.io\/[A-Za-z0-9._-]+\/(?<image>byok-grid-[a-z0-9-]+))@(?<digest>sha256:[0-9a-f]{64})$/
    );
    if (!match?.groups) {
      throw new Error(`Invalid immutable image reference: ${line}`);
    }
    if (records.has(match.groups.image)) {
      throw new Error(`Duplicate digest record for ${match.groups.image}.`);
    }
    records.set(match.groups.image, {
      repository: match.groups.repository,
      digest: match.groups.digest,
    });
  }

  return records;
}

function validateReleaseConfig(config) {
  if (config?.schemaVersion !== 1 || !Array.isArray(config.images)) {
    throw new Error('release-images.json must use schemaVersion 1.');
  }
  const images = new Map();
  const imageNames = new Set();
  for (const entry of config.images) {
    if (
      typeof entry?.target !== 'string' ||
      typeof entry?.image !== 'string' ||
      !/^[a-z0-9][a-z0-9-]*$/.test(entry.target) ||
      !/^byok-grid-[a-z0-9-]+$/.test(entry.image) ||
      images.has(entry.target) ||
      imageNames.has(entry.image)
    ) {
      throw new Error(
        'Release image targets and names must be safe and unique.'
      );
    }
    images.set(entry.target, entry.image);
    imageNames.add(entry.image);
  }
  return images;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const [manifestPath, outputPath] = process.argv.slice(2);
  if (!manifestPath || !outputPath || process.argv.length !== 4) {
    console.error(
      'Usage: node scripts/generate-helm-digest-values.mjs IMAGE_DIGESTS.txt values.digests.yaml'
    );
    process.exit(1);
  }

  try {
    const manifest = readFileSync(manifestPath, 'utf8');
    const releaseConfig = JSON.parse(
      readFileSync('release-images.json', 'utf8')
    );
    writeFileSync(
      outputPath,
      generateHelmDigestValues(manifest, releaseConfig),
      'utf8'
    );
  } catch (error) {
    console.error(
      `Failed to generate Helm digest values: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
