import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  collectReleaseDigests,
  createChecksumManifest,
  packageRelease,
} from './package-release.mjs';

const releaseImages = [
  ['web', 'byok-grid-web'],
  ['workflow-worker', 'byok-grid-workflow-worker'],
  ['migration', 'byok-grid-migration'],
  ['maintenance', 'byok-grid-maintenance'],
  ['connector-runner', 'byok-grid-connector-runner'],
  ['airbyte-destination', 'byok-grid-airbyte-destination'],
  ['analytics-projector', 'byok-grid-analytics-projector'],
].map(([target, image]) => ({ target, image }));
const releaseConfig = { schemaVersion: 1, images: releaseImages };

test('collects exactly one immutable digest for every release target', () => {
  withFixture(({ digests }) => {
    const manifest = collectReleaseDigests(digests, releaseConfig);
    const lines = manifest.trim().split('\n');

    assert.equal(lines.length, 7);
    assert.deepEqual(lines, [...lines].sort());
    assert.match(manifest, /byok-grid-web@sha256:1{64}/);

    writeFileSync(join(digests, 'unexpected.txt'), 'unexpected', 'utf8');
    assert.throws(
      () => collectReleaseDigests(digests, releaseConfig),
      /Unexpected digest artifact/
    );
  });
});

test('assembles a complete release atomically with portable checksums', () => {
  withFixture(({ root, digests }) => {
    const output = join(root, 'dist', 'release');
    const runCommand = (command, args) => {
      const destinationFlag =
        command === 'helm' ? '--destination' : '--pack-destination';
      const destination = args[args.indexOf(destinationFlag) + 1];
      const filename =
        command === 'helm'
          ? 'byok-grid-0.1.0-rc.1.tgz'
          : 'byok-grid-connector-sdk-0.2.0.tgz';
      writeFileSync(join(destination, filename), `${command}-artifact`, 'utf8');
    };

    packageRelease({
      version: '0.1.0-rc.1',
      digestsDirectory: digests,
      outputDirectory: output,
      rootDirectory: root,
      runCommand,
    });

    assert.deepEqual(readdirSync(output).sort(), [
      'IMAGE_DIGESTS.txt',
      'SHA256SUMS',
      'byok-grid-0.1.0-rc.1.tgz',
      'byok-grid-connector-sdk-0.2.0.tgz',
      'values.digests.yaml',
    ]);
    const checksums = readFileSync(join(output, 'SHA256SUMS'), 'utf8');
    const chartHash = createHash('sha256')
      .update('helm-artifact')
      .digest('hex');
    assert.match(
      checksums,
      new RegExp(`^${chartHash}  byok-grid-0\\.1\\.0-rc\\.1\\.tgz$`, 'm')
    );
    assert.doesNotMatch(checksums, /SHA256SUMS/);
    assert.throws(
      () =>
        packageRelease({
          version: '0.1.0-rc.1',
          digestsDirectory: digests,
          outputDirectory: output,
          rootDirectory: root,
          runCommand,
        }),
      /output already exists/
    );
  });
});

test('removes staging output when artifact creation fails', () => {
  withFixture(({ root, digests }) => {
    const output = join(root, 'dist', 'release');

    assert.throws(
      () =>
        packageRelease({
          version: '0.1.0-rc.1',
          digestsDirectory: digests,
          outputDirectory: output,
          rootDirectory: root,
          runCommand: () => {
            throw new Error('simulated packaging failure');
          },
        }),
      /simulated packaging failure/
    );
    assert.equal(existsSync(output), false);
    assert.deepEqual(
      readdirSync(join(root, 'dist')).filter((name) => name.includes('.tmp-')),
      []
    );
  });
});

test('refuses empty checksum sets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'byok-grid-empty-release-'));
  try {
    assert.throws(() => createChecksumManifest(directory), /empty release/);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
});

test('rejects unsafe release target paths', () => {
  withFixture(({ digests }) => {
    const unsafeConfig = structuredClone(releaseConfig);
    unsafeConfig.images[0].target = '../web';
    assert.throws(
      () => collectReleaseDigests(digests, unsafeConfig),
      /targets and names must be safe and unique/
    );
  });
});

test('rejects non-canonical numeric prerelease identifiers', () => {
  withFixture(({ root, digests }) => {
    assert.throws(
      () =>
        packageRelease({
          version: '0.1.0-01',
          digestsDirectory: digests,
          outputDirectory: join(root, 'dist', 'release'),
          rootDirectory: root,
          runCommand: () => undefined,
        }),
      /Invalid release version/
    );
  });
});

test(
  'assembles real Helm and npm packages with the local toolchain',
  { skip: process.env.BYOK_GRID_RELEASE_INTEGRATION !== '1' },
  () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-real-release-'));
    const digests = join(directory, 'release-digests');
    const output = join(directory, 'release');
    mkdirSync(digests, { recursive: true });
    writeDigestFixtures(digests);

    try {
      packageRelease({
        version: '0.1.0-rc.1',
        digestsDirectory: digests,
        outputDirectory: output,
      });
      assert.equal(existsSync(join(output, 'byok-grid-0.1.0-rc.1.tgz')), true);
      assert.equal(
        readdirSync(output).filter((name) => name.endsWith('.tgz')).length,
        2
      );
      assert.equal(
        readFileSync(join(output, 'SHA256SUMS'), 'utf8').trim().split('\n')
          .length,
        4
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'byok-grid-release-package-'));
  const digests = join(root, 'release-digests');
  mkdirSync(digests, { recursive: true });
  writeFileSync(
    join(root, 'release-images.json'),
    `${JSON.stringify(releaseConfig)}\n`,
    'utf8'
  );
  writeDigestFixtures(digests);
  try {
    callback({ root, digests });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeDigestFixtures(digests) {
  releaseImages.forEach(({ image, target }, index) => {
    writeFileSync(
      join(digests, `${target}.txt`),
      `ghcr.io/mherzog4/${image}@sha256:${String(index + 1).repeat(64)}\n`,
      'utf8'
    );
  });
}
