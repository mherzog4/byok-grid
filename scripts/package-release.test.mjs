import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
  collectReleaseSmokeEvidence,
  createChecksumManifest,
  packageRelease,
} from './package-release.mjs';
import { RELEASE_IMAGE_SMOKE_MARKER } from './verify-release-image-smoke-lib.mjs';
import { RELEASE_BUNDLE_MARKER } from './verify-release-bundle-lib.mjs';

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

test('consolidates exactly two digest-bound smoke records per target', () => {
  withFixture(({ digests, smoke }) => {
    const digestManifest = collectReleaseDigests(digests, releaseConfig);
    const evidence = collectReleaseSmokeEvidence(
      smoke,
      digestManifest,
      releaseConfig
    );
    const records = evidence
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(records.length, 14);
    assert.deepEqual(
      records
        .filter(({ target }) => target === 'web')
        .map(({ platform }) => platform),
      ['linux/amd64', 'linux/arm64']
    );
    assert.equal(records[0].target, 'airbyte-destination');
    assert.equal(records.at(-1).target, 'workflow-worker');

    writeFileSync(join(smoke, 'unexpected.jsonl'), '{}\n', 'utf8');
    assert.throws(
      () => collectReleaseSmokeEvidence(smoke, digestManifest, releaseConfig),
      /Unexpected image smoke artifact/u
    );
  });
});

test('rejects mismatched, duplicate, and truncated smoke evidence', () => {
  withFixture(({ digests, smoke }) => {
    const digestManifest = collectReleaseDigests(digests, releaseConfig);
    const webPath = join(smoke, 'web.jsonl');
    const original = readFileSync(webPath, 'utf8');
    const records = original
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    writeFileSync(
      webPath,
      `${JSON.stringify({ ...records[0], digest: `sha256:${'f'.repeat(64)}` })}\n${JSON.stringify(records[1])}\n`,
      'utf8'
    );
    assert.throws(
      () => collectReleaseSmokeEvidence(smoke, digestManifest, releaseConfig),
      /does not match its release image/u
    );

    writeFileSync(
      webPath,
      `${JSON.stringify(records[0])}\n${JSON.stringify(records[0])}\n`,
      'utf8'
    );
    assert.throws(
      () => collectReleaseSmokeEvidence(smoke, digestManifest, releaseConfig),
      /repeats linux\/arm64/u
    );

    writeFileSync(webPath, original.trim(), 'utf8');
    assert.throws(
      () => collectReleaseSmokeEvidence(smoke, digestManifest, releaseConfig),
      /must end with a newline/u
    );
  });
});

test('assembles a complete release atomically with portable checksums', () => {
  withFixture(({ root, digests, smoke }) => {
    const output = join(root, 'dist', 'release');
    let npmCache;
    const runCommand = (command, args) => {
      const destinationFlag =
        command === 'helm' ? '--destination' : '--pack-destination';
      const destination = args[args.indexOf(destinationFlag) + 1];
      if (command === 'npm') {
        npmCache = args[args.indexOf('--cache') + 1];
        assert.equal(existsSync(npmCache), true);
        assert.match(npmCache, /\.npm-cache\.tmp-/u);
      }
      const filename =
        command === 'helm'
          ? 'byok-grid-0.1.0-rc.1.tgz'
          : 'byok-grid-connector-sdk-0.2.0.tgz';
      writeFileSync(join(destination, filename), `${command}-artifact`, 'utf8');
    };

    packageRelease({
      version: '0.1.0-rc.1',
      digestsDirectory: digests,
      smokeDirectory: smoke,
      outputDirectory: output,
      rootDirectory: root,
      runCommand,
    });

    assert.deepEqual(readdirSync(output).sort(), [
      'IMAGE_DIGESTS.txt',
      'IMAGE_SMOKE.jsonl',
      'SHA256SUMS',
      'byok-grid-0.1.0-rc.1.tgz',
      'byok-grid-connector-sdk-0.2.0.tgz',
      'values.digests.yaml',
    ]);
    assert.equal(existsSync(npmCache), false);
    const checksums = readFileSync(join(output, 'SHA256SUMS'), 'utf8');
    const chartHash = createHash('sha256')
      .update('helm-artifact')
      .digest('hex');
    assert.match(
      checksums,
      new RegExp(`^${chartHash}  byok-grid-0\\.1\\.0-rc\\.1\\.tgz$`, 'm')
    );
    assert.equal(
      readFileSync(join(output, 'IMAGE_SMOKE.jsonl'), 'utf8').trim().split('\n')
        .length,
      14
    );
    assert.doesNotMatch(checksums, /SHA256SUMS/);
    assert.throws(
      () =>
        packageRelease({
          version: '0.1.0-rc.1',
          digestsDirectory: digests,
          smokeDirectory: smoke,
          outputDirectory: output,
          rootDirectory: root,
          runCommand,
        }),
      /output already exists/
    );
  });
});

test('removes staging output when artifact creation fails', () => {
  withFixture(({ root, digests, smoke }) => {
    const output = join(root, 'dist', 'release');

    assert.throws(
      () =>
        packageRelease({
          version: '0.1.0-rc.1',
          digestsDirectory: digests,
          smokeDirectory: smoke,
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
  withFixture(({ root, digests, smoke }) => {
    assert.throws(
      () =>
        packageRelease({
          version: '0.1.0-01',
          digestsDirectory: digests,
          smokeDirectory: smoke,
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
    const smoke = join(directory, 'release-smoke');
    const output = join(directory, 'release');
    mkdirSync(digests, { recursive: true });
    mkdirSync(smoke, { recursive: true });
    writeDigestFixtures(digests);
    writeSmokeFixtures(smoke);

    try {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/package-release.mjs',
          '--version',
          '0.1.0-rc.1',
          '--digests-dir',
          digests,
          '--smoke-dir',
          smoke,
          '--output-dir',
          output,
        ],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /assembled atomically/u);
      const verification = spawnSync(
        process.execPath,
        [
          'scripts/verify-release-bundle.mjs',
          '--version',
          '0.1.0-rc.1',
          '--directory',
          output,
        ],
        { encoding: 'utf8' }
      );
      assert.equal(
        verification.status,
        0,
        `${verification.stdout}\n${verification.stderr}`
      );
      assert.equal(
        JSON.parse(verification.stdout).marker,
        RELEASE_BUNDLE_MARKER
      );
      assert.equal(existsSync(join(output, 'byok-grid-0.1.0-rc.1.tgz')), true);
      assert.equal(
        readdirSync(output).filter((name) => name.endsWith('.tgz')).length,
        2
      );
      assert.equal(
        readFileSync(join(output, 'SHA256SUMS'), 'utf8').trim().split('\n')
          .length,
        5
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
);

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'byok-grid-release-package-'));
  const digests = join(root, 'release-digests');
  const smoke = join(root, 'release-smoke');
  mkdirSync(digests, { recursive: true });
  mkdirSync(smoke, { recursive: true });
  writeFileSync(
    join(root, 'release-images.json'),
    `${JSON.stringify(releaseConfig)}\n`,
    'utf8'
  );
  writeDigestFixtures(digests);
  writeSmokeFixtures(smoke);
  try {
    callback({ root, digests, smoke });
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

function writeSmokeFixtures(smoke) {
  releaseImages.forEach(({ target }, index) => {
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    const records = ['linux/arm64', 'linux/amd64'].map((platform) =>
      JSON.stringify({
        digest,
        marker: RELEASE_IMAGE_SMOKE_MARKER,
        platform,
        target,
      })
    );
    writeFileSync(
      join(smoke, `${target}.jsonl`),
      `${records.join('\n')}\n`,
      'utf8'
    );
  });
}
