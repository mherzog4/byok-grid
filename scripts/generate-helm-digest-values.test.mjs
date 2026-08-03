import assert from 'node:assert/strict';
import test from 'node:test';

import { generateHelmDigestValues } from './generate-helm-digest-values.mjs';

const releaseConfig = {
  schemaVersion: 1,
  images: [
    ['web', 'byok-grid-web'],
    ['workflow-worker', 'byok-grid-workflow-worker'],
    ['migration', 'byok-grid-migration'],
    ['maintenance', 'byok-grid-maintenance'],
    ['connector-runner', 'byok-grid-connector-runner'],
    ['airbyte-destination', 'byok-grid-airbyte-destination'],
    ['analytics-projector', 'byok-grid-analytics-projector'],
  ].map(([target, image]) => ({ target, image })),
};

function manifestLine(image, digit) {
  return `ghcr.io/mherzog4/${image}@sha256:${digit.repeat(64)}`;
}

const validManifest = releaseConfig.images
  .map(({ image }, index) => manifestLine(image, String(index + 1)))
  .join('\n');

test('generates chart values for every chart-owned image digest', () => {
  const values = generateHelmDigestValues(validManifest, releaseConfig);

  assert.match(values, /^web:\n  image:\n/m);
  assert.match(values, /^worker:\n  image:\n/m);
  assert.match(values, /^connectorRunner:\n  image:\n/m);
  assert.match(
    values,
    /repository: 'ghcr\.io\/mherzog4\/byok-grid-web'\n    tag: ''\n/
  );
  assert.match(values, /digest: 'sha256:1{64}'/);
  assert.match(values, /digest: 'sha256:5{64}'/);
  assert.doesNotMatch(values, /^maintenance:/m);
  assert.doesNotMatch(values, /^airbyteDestination:/m);
});

test('rejects a missing release image before producing partial values', () => {
  const incomplete = validManifest
    .split('\n')
    .filter((line) => !line.includes('byok-grid-web@'))
    .join('\n');

  assert.throws(
    () => generateHelmDigestValues(incomplete, releaseConfig),
    /missing web\/byok-grid-web/
  );
});

test('rejects duplicate and mutable image references', () => {
  assert.throws(
    () =>
      generateHelmDigestValues(
        `${validManifest}\n${manifestLine('byok-grid-web', '1')}`,
        releaseConfig
      ),
    /Duplicate digest record/
  );
  assert.throws(
    () =>
      generateHelmDigestValues(
        validManifest.replace(/@sha256:1{64}/, ':latest'),
        releaseConfig
      ),
    /Invalid immutable image reference/
  );
});

test('rejects duplicate release image configuration', () => {
  const duplicateConfig = structuredClone(releaseConfig);
  duplicateConfig.images[1].image = duplicateConfig.images[0].image;

  assert.throws(
    () => generateHelmDigestValues(validManifest, duplicateConfig),
    /targets and names must be safe and unique/
  );
});
