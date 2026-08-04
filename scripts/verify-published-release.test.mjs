import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  PUBLISHED_RELEASE_MARKER,
  PublishedReleaseError,
  verifyPublishedRelease,
} from './verify-published-release-lib.mjs';

const version = '0.1.0-rc.1';
const releaseNotes = `# BYOK Grid ${version}\n\nReviewed release notes.\n`;
const assetNames = [
  'IMAGE_DIGESTS.txt',
  'IMAGE_SMOKE.jsonl',
  'SHA256SUMS',
  'byok-grid-0.1.0-rc.1.tgz',
  'byok-grid-connector-sdk-0.2.0.tgz',
  'values.digests.yaml',
];

test('verifies an immutable release and every server-computed asset digest', async () => {
  await withPublishedRelease(async ({ directory, release }) => {
    assert.deepEqual(
      await verifyPublishedRelease({
        directory,
        release,
        releaseNotes,
        version,
      }),
      {
        assets: 6,
        immutable: true,
        marker: PUBLISHED_RELEASE_MARKER,
        prerelease: true,
        version,
      }
    );
  });
});

test('rejects a mutable or incorrectly classified release', async () => {
  await withPublishedRelease(async ({ directory, release }) => {
    await assert.rejects(
      verifyPublishedRelease({
        directory,
        release: { ...release, immutable: false },
        releaseNotes,
        version,
      }),
      PublishedReleaseError
    );
    await assert.rejects(
      verifyPublishedRelease({
        directory,
        release: { ...release, prerelease: false },
        releaseNotes,
        version,
      }),
      PublishedReleaseError
    );
  });
});

test('accepts GitHub whole-second timestamps and rejects noncanonical offsets', async () => {
  await withPublishedRelease(async ({ directory, release }) => {
    await assert.doesNotReject(
      verifyPublishedRelease({
        directory,
        release: { ...release, published_at: '2026-08-04T00:00:00Z' },
        releaseNotes,
        version,
      })
    );
    await assert.rejects(
      verifyPublishedRelease({
        directory,
        release: {
          ...release,
          published_at: '2026-08-03T20:00:00-04:00',
        },
        releaseNotes,
        version,
      }),
      /metadata is invalid/u
    );
  });
});

test('requires the reviewed release-note body with only newline normalization', async () => {
  await withPublishedRelease(async ({ directory, release }) => {
    await assert.doesNotReject(
      verifyPublishedRelease({
        directory,
        release: { ...release, body: releaseNotes.slice(0, -1) },
        releaseNotes,
        version,
      })
    );
    await assert.rejects(
      verifyPublishedRelease({
        directory,
        release: { ...release, body: `${releaseNotes}Generated addition.` },
        releaseNotes,
        version,
      }),
      /metadata is invalid/u
    );
  });
});

test('rejects missing, duplicate, or unexpected published assets', async () => {
  await withPublishedRelease(async ({ directory, release }) => {
    await assert.rejects(
      verifyPublishedRelease({
        directory,
        release: { ...release, assets: release.assets.slice(1) },
        releaseNotes,
        version,
      }),
      /exact packaged assets/u
    );
    await assert.rejects(
      verifyPublishedRelease({
        directory,
        release: {
          ...release,
          assets: [...release.assets, release.assets[0]],
        },
        releaseNotes,
        version,
      }),
      /duplicate asset/u
    );
  });
});

test('rejects a server digest or size that does not match local bytes', async () => {
  await withPublishedRelease(async ({ directory, release }) => {
    const [first, ...rest] = release.assets;
    await assert.rejects(
      verifyPublishedRelease({
        directory,
        release: {
          ...release,
          assets: [{ ...first, digest: `sha256:${'f'.repeat(64)}` }, ...rest],
        },
        releaseNotes,
        version,
      }),
      /digest does not match/u
    );
    await assert.rejects(
      verifyPublishedRelease({
        directory,
        release: {
          ...release,
          assets: [{ ...first, size: first.size + 1 }, ...rest],
        },
        releaseNotes,
        version,
      }),
      /invalid metadata/u
    );
  });
});

test('the CLI emits one bounded verification record', async () => {
  await withPublishedRelease(async ({ directory, release, root }) => {
    const response = join(root, 'release.json');
    const notesFile = join(root, 'release-notes.md');
    writeFileSync(response, `${JSON.stringify(release)}\n`, 'utf8');
    writeFileSync(notesFile, releaseNotes, 'utf8');
    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-published-release.mjs',
        '--version',
        version,
        '--directory',
        directory,
        '--release-json',
        response,
        '--notes-file',
        notesFile,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(JSON.parse(result.stdout).marker, PUBLISHED_RELEASE_MARKER);

    writeFileSync(response, '{"operator-secret":', 'utf8');
    const failure = spawnSync(
      process.execPath,
      [
        'scripts/verify-published-release.mjs',
        '--version',
        version,
        '--directory',
        directory,
        '--release-json',
        response,
        '--notes-file',
        notesFile,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(failure.status, 1);
    assert.equal(failure.stdout, '');
    assert.match(failure.stderr, /not valid JSON/u);
    assert.doesNotMatch(failure.stderr, /operator-secret|release\.json/u);
  });
});

async function withPublishedRelease(callback) {
  const root = mkdtempSync(join(tmpdir(), 'byok-grid-published-release-'));
  const directory = join(root, 'release');
  mkdirSync(directory);
  const assets = assetNames.map((name, index) => {
    const contents = `release-asset-${index}\n`;
    writeFileSync(join(directory, name), contents, 'utf8');
    return {
      browser_download_url: `https://github.com/mherzog4/byok-grid/releases/download/v${version}/${name}`,
      digest: `sha256:${createHash('sha256').update(contents).digest('hex')}`,
      name,
      size: Buffer.byteLength(contents),
      state: 'uploaded',
    };
  });
  const release = {
    assets,
    body: releaseNotes,
    draft: false,
    html_url: `https://github.com/mherzog4/byok-grid/releases/tag/v${version}`,
    id: 42,
    immutable: true,
    name: `BYOK Grid ${version}`,
    prerelease: true,
    published_at: '2026-08-04T00:00:00.000Z',
    tag_name: `v${version}`,
  };
  try {
    await callback({ directory, release, root });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}
