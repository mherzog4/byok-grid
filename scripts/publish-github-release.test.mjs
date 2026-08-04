import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

import {
  GITHUB_RELEASE_PUBLICATION_MARKER,
  GitHubReleasePublicationError,
  createGitHubReleaseInspector,
  publishGitHubRelease,
} from './publish-github-release-lib.mjs';

const version = '0.1.0-rc.1';
const repository = 'mherzog4/byok-grid';
const releaseNotes = `# BYOK Grid ${version}\n\nReviewed release notes.\n`;
const assetNames = Array.from(
  { length: 6 },
  (_, index) => `asset-${index}.txt`
);
const fixtureRoots = [];

after(() => {
  for (const root of fixtureRoots)
    rmSync(root, { force: true, recursive: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'byok-grid-release-publish-'));
  fixtureRoots.push(root);
  const directory = join(root, 'release');
  mkdirSync(directory);
  const assets = assetNames.map((name, index) => {
    const contents = `release-asset-${index}\n`;
    writeFileSync(join(directory, name), contents, 'utf8');
    return {
      browser_download_url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
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
    html_url: `https://github.com/${repository}/releases/tag/v${version}`,
    id: 42,
    immutable: true,
    name: `BYOK Grid ${version}`,
    prerelease: true,
    published_at: '2026-08-04T00:00:00Z',
    tag_name: `v${version}`,
  };
  return { directory, release, root };
}

function options(overrides = {}) {
  const { directory, release } = fixture();
  return {
    createRelease: async () => {},
    directory,
    inspectRelease: async () => ({ release, status: 'present' }),
    inspectionAttempts: 2,
    releaseNotes,
    verifyBundle: async () => ({ assets: 6 }),
    version,
    wait: async () => {},
    ...overrides,
  };
}

test('treats an existing identical immutable release as a no-op', async () => {
  let creations = 0;
  const result = await publishGitHubRelease(
    options({
      createRelease: async () => {
        creations += 1;
      },
    })
  );

  assert.equal(creations, 0);
  assert.equal(result.created, false);
  assert.equal(result.existing, true);
  assert.equal(result.recovered, false);
  assert.equal(result.immutable, true);
  assert.equal(result.marker, GITHUB_RELEASE_PUBLICATION_MARKER);
});

test('creates an absent release and verifies the published bytes', async () => {
  const base = options();
  const release = fixture().release;
  let state = { status: 'absent' };
  let creations = 0;

  const result = await publishGitHubRelease({
    ...base,
    createRelease: async () => {
      creations += 1;
      state = { release, status: 'present' };
    },
    inspectRelease: async () => state,
  });

  assert.equal(creations, 1);
  assert.equal(result.created, true);
  assert.equal(result.existing, false);
  assert.equal(result.recovered, false);
  assert.equal(result.release, release);
});

test('rejects an existing conflicting release without mutation', async () => {
  const base = options();
  let creations = 0;

  await assert.rejects(
    publishGitHubRelease({
      ...base,
      createRelease: async () => {
        creations += 1;
      },
      inspectRelease: async () => ({
        release: { ...(await base.inspectRelease()).release, immutable: false },
        status: 'present',
      }),
    }),
    /existing GitHub Release conflicts/u
  );
  assert.equal(creations, 0);
});

test('verifies the local bundle before inspecting or mutating GitHub', async () => {
  let inspections = 0;
  let creations = 0;

  await assert.rejects(
    publishGitHubRelease(
      options({
        createRelease: async () => {
          creations += 1;
        },
        inspectRelease: async () => {
          inspections += 1;
          return { status: 'absent' };
        },
        verifyBundle: async () => {
          throw new Error('untrusted local failure details');
        },
      })
    ),
    /local release bundle failed verification/u
  );
  assert.equal(inspections, 0);
  assert.equal(creations, 0);
});

test('recovers when create reports failure but an identical release exists', async () => {
  const base = options();
  const release = fixture().release;
  let state = { status: 'absent' };

  const result = await publishGitHubRelease({
    ...base,
    createRelease: async () => {
      state = { release, status: 'present' };
      throw new Error('provider returned a sensitive transport failure');
    },
    inspectRelease: async () => state,
  });

  assert.equal(result.created, false);
  assert.equal(result.existing, true);
  assert.equal(result.recovered, true);
});

test('fails after a bounded wait when creation leaves no release', async () => {
  let inspections = 0;
  let waits = 0;

  await assert.rejects(
    publishGitHubRelease(
      options({
        createRelease: async () => {
          throw new Error('provider error that must not be echoed');
        },
        inspectRelease: async () => {
          inspections += 1;
          return { status: 'absent' };
        },
        wait: async () => {
          waits += 1;
        },
      })
    ),
    /not published before the verification deadline/u
  );
  assert.equal(inspections, 3);
  assert.equal(waits, 1);
});

test('fails closed on inspection errors without calling create', async () => {
  let creations = 0;

  await assert.rejects(
    publishGitHubRelease(
      options({
        createRelease: async () => {
          creations += 1;
        },
        inspectRelease: async () => {
          throw new Error('network failure with provider details');
        },
      })
    ),
    /could not be inspected/u
  );
  assert.equal(creations, 0);
});

test('the API inspector distinguishes authenticated absence from failures', async () => {
  async function inspectWith(response) {
    const inspector = createGitHubReleaseInspector({
      fetchImplementation: async () => response,
      repository,
      token: 'sensitive-token',
      version,
    });
    return inspector();
  }

  assert.deepEqual(await inspectWith(new Response(null, { status: 404 })), {
    status: 'absent',
  });
  await assert.rejects(
    inspectWith(new Response(null, { status: 503 })),
    /unexpected status/u
  );
  await assert.rejects(
    inspectWith(new Response('{invalid', { status: 200 })),
    /invalid JSON/u
  );
});

test('the API inspector uses fixed GitHub headers and returns a release', async () => {
  const { release } = fixture();
  const calls = [];
  const inspector = createGitHubReleaseInspector({
    fetchImplementation: async (url, request) => {
      calls.push({ request, url });
      return new Response(JSON.stringify(release), { status: 200 });
    },
    repository,
    token: 'sensitive-token',
    version,
  });

  assert.deepEqual(await inspector(), { release, status: 'present' });
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${repository}/releases/tags/v${version}`
  );
  assert.equal(calls[0].request.method, 'GET');
  assert.equal(
    calls[0].request.headers.authorization,
    'Bearer sensitive-token'
  );
  assert.equal(calls[0].request.headers['x-github-api-version'], '2026-03-10');
});

test('bounds API responses and redacts fetch failure details', async () => {
  const secret = 'credential-that-must-stay-private';
  const oversized = createGitHubReleaseInspector({
    fetchImplementation: async () => new Response('x'.repeat(1_048_577)),
    repository,
    token: secret,
    version,
  });
  await assert.rejects(oversized(), /oversized response/u);

  const failed = createGitHubReleaseInspector({
    fetchImplementation: async () => {
      throw new Error(`provider included ${secret}`);
    },
    repository,
    token: secret,
    version,
  });
  await assert.rejects(failed(), (error) => {
    assert.ok(error instanceof GitHubReleasePublicationError);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('the CLI rejects a wrong repository without exposing credentials', () => {
  const { directory, root } = fixture();
  const notes = join(root, 'notes.md');
  const response = join(root, 'release.json');
  writeFileSync(notes, releaseNotes, 'utf8');
  const secret = 'cli-secret-that-must-stay-private';
  const result = spawnSync(
    process.execPath,
    [
      'scripts/publish-github-release.mjs',
      '--version',
      version,
      '--directory',
      directory,
      '--notes-file',
      notes,
      '--release-json',
      response,
      '--repository',
      'attacker/example',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, GH_TOKEN: secret },
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /repository identity is invalid/u);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});
