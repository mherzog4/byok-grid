import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createChecksumManifest, packageRelease } from './package-release.mjs';
import {
  RELEASE_BUNDLE_MARKER,
  verifyReleaseBundle,
} from './verify-release-bundle-lib.mjs';
import { RELEASE_IMAGE_SMOKE_MARKER } from './verify-release-image-smoke-lib.mjs';

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

test('verifies the exact release bundle and semantic manifests', async () => {
  await withBundle(async ({ output, root }) => {
    assert.deepEqual(
      await verifyReleaseBundle({
        directory: output,
        rootDirectory: root,
        version: '0.1.0-rc.1',
      }),
      {
        assets: 6,
        images: 7,
        marker: RELEASE_BUNDLE_MARKER,
        smokeRecords: 14,
        version: '0.1.0-rc.1',
      }
    );
    await assert.rejects(
      verifyReleaseBundle({
        directory: output,
        rootDirectory: root,
        version: '0.1.0-rc.2',
      }),
      /does not match the source version/u
    );
  });
});

test('rejects an asset whose bytes do not match SHA256SUMS', async () => {
  await withBundle(async ({ output, root }) => {
    writeFileSync(
      join(output, 'byok-grid-0.1.0-rc.1.tgz'),
      'tampered-chart',
      'utf8'
    );
    await assert.rejects(
      verifyReleaseBundle({
        directory: output,
        rootDirectory: root,
        version: '0.1.0-rc.1',
      }),
      /does not match SHA256SUMS/u
    );
  });
});

test('rejects self-consistent checksums over invalid smoke evidence', async () => {
  await withBundle(async ({ output, root }) => {
    const path = join(output, 'IMAGE_SMOKE.jsonl');
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    const first = JSON.parse(lines[0]);
    lines[0] = JSON.stringify({
      ...first,
      digest: `sha256:${'f'.repeat(64)}`,
    });
    writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
    rewriteChecksums(output);

    await assert.rejects(
      verifyReleaseBundle({
        directory: output,
        rootDirectory: root,
        version: '0.1.0-rc.1',
      }),
      /IMAGE_SMOKE\.jsonl is invalid/u
    );
  });
});

test('rejects self-consistent checksums over drifted Helm values', async () => {
  await withBundle(async ({ output, root }) => {
    writeFileSync(
      join(output, 'values.digests.yaml'),
      '# operator-modified\n',
      'utf8'
    );
    rewriteChecksums(output);

    await assert.rejects(
      verifyReleaseBundle({
        directory: output,
        rootDirectory: root,
        version: '0.1.0-rc.1',
      }),
      /does not match IMAGE_DIGESTS\.txt/u
    );
  });
});

test('requires the exact closed release asset set', async () => {
  await withBundle(async ({ output, root }) => {
    writeFileSync(join(output, '.unexpected'), 'unexpected', 'utf8');
    await assert.rejects(
      verifyReleaseBundle({
        directory: output,
        rootDirectory: root,
        version: '0.1.0-rc.1',
      }),
      /exact expected asset set/u
    );
  });
});

test('rejects unbounded version input before filesystem access', async () => {
  await assert.rejects(
    verifyReleaseBundle({
      directory: '/not-inspected',
      version: `1.0.0-${'a'.repeat(129)}`,
    }),
    /canonical SemVer/u
  );
});

test('exposes one safe machine-readable CLI result', async () => {
  await withBundle(async ({ output, root }) => {
    const success = runCli(output);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stderr, '');
    assert.deepEqual(JSON.parse(success.stdout), {
      assets: 6,
      images: 7,
      marker: RELEASE_BUNDLE_MARKER,
      smokeRecords: 14,
      version: '0.1.0-rc.1',
    });

    writeFileSync(join(output, 'operator-secret-artifact'), 'secret', 'utf8');
    const failure = runCli(output);
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /exact expected asset set/u);
    assert.doesNotMatch(failure.stderr, /operator-secret|byok-grid-bundle/u);
    assert.ok(root.length > 0);
  });
});

async function withBundle(callback) {
  const root = mkdtempSync(join(tmpdir(), 'byok-grid-bundle-'));
  const digests = join(root, 'release-digests');
  const smoke = join(root, 'release-smoke');
  const output = join(root, 'dist', 'release');
  mkdirSync(digests, { recursive: true });
  mkdirSync(smoke, { recursive: true });
  mkdirSync(join(root, 'deploy', 'helm', 'byok-grid', 'templates'), {
    recursive: true,
  });
  mkdirSync(join(root, 'packages', 'connector-sdk'), { recursive: true });
  writeFileSync(
    join(root, 'deploy', 'helm', 'byok-grid', 'Chart.yaml'),
    'apiVersion: v2\nname: byok-grid\nversion: 0.1.0-rc.1\n',
    'utf8'
  );
  writeFileSync(
    join(root, 'deploy', 'helm', 'byok-grid', 'templates', 'web.yaml'),
    'kind: Deployment\n',
    'utf8'
  );
  writeFileSync(
    join(root, 'release-images.json'),
    `${JSON.stringify(releaseConfig)}\n`,
    'utf8'
  );
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'byok-grid', version: '0.1.0-rc.1' })}\n`,
    'utf8'
  );
  writeFileSync(
    join(root, 'packages', 'connector-sdk', 'package.json'),
    `${JSON.stringify({ name: '@byok-grid/connector-sdk', version: '0.2.0' })}\n`,
    'utf8'
  );
  writeFixtures(digests, smoke);

  packageRelease({
    version: '0.1.0-rc.1',
    digestsDirectory: digests,
    smokeDirectory: smoke,
    outputDirectory: output,
    rootDirectory: root,
    runCommand(command, args) {
      const destinationFlag =
        command === 'helm' ? '--destination' : '--pack-destination';
      const destination = args[args.indexOf(destinationFlag) + 1];
      const name =
        command === 'helm'
          ? 'byok-grid-0.1.0-rc.1.tgz'
          : 'byok-grid-connector-sdk-0.2.0.tgz';
      writeFileSync(join(destination, name), `${command}-archive`, 'utf8');
    },
  });

  try {
    await callback({ output, root });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function writeFixtures(digests, smoke) {
  releaseImages.forEach(({ image, target }, index) => {
    const digest = `sha256:${String(index + 1).repeat(64)}`;
    writeFileSync(
      join(digests, `${target}.txt`),
      `ghcr.io/mherzog4/${image}@${digest}\n`,
      'utf8'
    );
    const records = ['linux/amd64', 'linux/arm64'].map((platform) =>
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

function rewriteChecksums(output) {
  writeFileSync(
    join(output, 'SHA256SUMS'),
    createChecksumManifest(output),
    'utf8'
  );
}

function runCli(output) {
  return spawnSync(
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
}
