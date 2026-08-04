import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  RELEASE_IMAGE_TAGS_MARKER,
  ReleaseImageTagsError,
  createGhcrTagInspector,
  publishReleaseImageTags,
  readReleaseImageTagInputs,
} from './publish-release-image-tags-lib.mjs';

const version = '0.1.0-rc.1';
const owner = 'mherzog4';
const config = {
  schemaVersion: 1,
  images: [
    { image: 'byok-grid-web', target: 'web' },
    { image: 'byok-grid-worker', target: 'worker' },
  ],
};

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'byok-grid-image-tags-'));
  config.images.forEach(({ image, target }, index) => {
    writeFileSync(
      join(directory, `${target}.txt`),
      `ghcr.io/${owner}/${image}@${digest(String(index + 1))}\n`,
      'utf8'
    );
  });
  const records = readReleaseImageTagInputs({
    digestsDirectory: directory,
    owner,
    releaseConfig: config,
    version,
  });
  return { directory, records };
}

test('reads the exact immutable release image inventory', () => {
  const { records } = fixture();

  assert.deepEqual(
    records.map(({ target, destination, digest: value }) => ({
      target,
      destination,
      digest: value,
    })),
    [
      {
        destination: `ghcr.io/${owner}/byok-grid-web:${version}`,
        digest: digest('1'),
        target: 'web',
      },
      {
        destination: `ghcr.io/${owner}/byok-grid-worker:${version}`,
        digest: digest('2'),
        target: 'worker',
      },
    ]
  );
});

test('rejects extra, malformed, and symlinked digest records', () => {
  const extra = fixture();
  writeFileSync(
    join(extra.directory, 'unexpected.txt'),
    'unexpected\n',
    'utf8'
  );
  assert.throws(
    () =>
      readReleaseImageTagInputs({
        digestsDirectory: extra.directory,
        owner,
        releaseConfig: config,
        version,
      }),
    /exact image records/
  );

  const malformed = fixture();
  writeFileSync(
    join(malformed.directory, 'web.txt'),
    `ghcr.io/${owner}/byok-grid-web:latest\n`,
    'utf8'
  );
  assert.throws(
    () =>
      readReleaseImageTagInputs({
        digestsDirectory: malformed.directory,
        owner,
        releaseConfig: config,
        version,
      }),
    /invalid immutable reference/
  );

  const linked = fixture();
  const source = join(tmpdir(), `byok-grid-image-tag-source-${Date.now()}.txt`);
  writeFileSync(source, `ghcr.io/${owner}/byok-grid-web@${digest('1')}\n`);
  unlinkSync(join(linked.directory, 'web.txt'));
  symlinkSync(source, join(linked.directory, 'web.txt'));
  assert.throws(
    () =>
      readReleaseImageTagInputs({
        digestsDirectory: linked.directory,
        owner,
        releaseConfig: config,
        version,
      }),
    /bounded regular file/
  );
});

test('publishes every absent tag and verifies its resulting digest', async () => {
  const { records } = fixture();
  const registry = new Map();
  const published = [];

  const result = await publishReleaseImageTags({
    records,
    inspectTag: async (record) =>
      registry.has(record.destination)
        ? { digest: registry.get(record.destination), status: 'present' }
        : { status: 'absent' },
    publishTag: async (record) => {
      published.push(record.destination);
      registry.set(record.destination, record.digest);
    },
  });

  assert.deepEqual(
    published,
    records.map(({ destination }) => destination)
  );
  assert.deepEqual(result, {
    created: 2,
    existing: 0,
    images: 2,
    marker: RELEASE_IMAGE_TAGS_MARKER,
    version,
  });
});

test('treats an existing identical tag as an idempotent no-op', async () => {
  const { records } = fixture();
  let publications = 0;

  const result = await publishReleaseImageTags({
    records,
    inspectTag: async (record) => ({
      digest: record.digest,
      status: 'present',
    }),
    publishTag: async () => {
      publications += 1;
    },
  });

  assert.equal(publications, 0);
  assert.equal(result.created, 0);
  assert.equal(result.existing, 2);
});

test('preflights every tag and publishes nothing when one digest conflicts', async () => {
  const { records } = fixture();
  let inspections = 0;
  let publications = 0;

  await assert.rejects(
    publishReleaseImageTags({
      records,
      inspectTag: async (record) => {
        inspections += 1;
        return record.target === 'worker'
          ? { digest: digest('f'), status: 'present' }
          : { status: 'absent' };
      },
      publishTag: async () => {
        publications += 1;
      },
    }),
    /already points to another digest/
  );
  assert.equal(inspections, 2);
  assert.equal(publications, 0);
});

test('rejects duplicate or mixed-version publication records before inspection', async () => {
  const { records } = fixture();
  let inspections = 0;
  const dependencies = {
    inspectTag: async () => {
      inspections += 1;
      return { status: 'absent' };
    },
    publishTag: async () => {},
  };

  await assert.rejects(
    publishReleaseImageTags({
      ...dependencies,
      records: [records[0], records[0]],
    }),
    /unique and version-bound/
  );
  assert.equal(inspections, 0);

  const mixed = structuredClone(records);
  mixed[1].version = '0.1.0-rc.2';
  mixed[1].destination = `${mixed[1].repository}:0.1.0-rc.2`;
  inspections = 0;
  await assert.rejects(
    publishReleaseImageTags({ ...dependencies, records: mixed }),
    /unique and version-bound/
  );
  assert.equal(inspections, 0);
});

test('fails closed when an absent tag changes before publication', async () => {
  const { records } = fixture();
  let inspections = 0;
  let publications = 0;

  await assert.rejects(
    publishReleaseImageTags({
      records,
      inspectTag: async () => {
        inspections += 1;
        return inspections <= records.length
          ? { status: 'absent' }
          : { digest: digest('f'), status: 'present' };
      },
      publishTag: async () => {
        publications += 1;
      },
    }),
    /changed during publication/
  );
  assert.equal(publications, 0);
});

test('fails closed when post-publication digest verification disagrees', async () => {
  const { records } = fixture();
  let inspections = 0;

  await assert.rejects(
    publishReleaseImageTags({
      records: [records[0]],
      inspectTag: async () => {
        inspections += 1;
        return inspections < 3
          ? { status: 'absent' }
          : { digest: digest('f'), status: 'present' };
      },
      publishTag: async () => {},
    }),
    /failed digest verification/
  );
});

test('revalidates an initially identical tag in the final closed set', async () => {
  const { records } = fixture();
  let inspections = 0;

  await assert.rejects(
    publishReleaseImageTags({
      records: [records[0]],
      inspectTag: async () => {
        inspections += 1;
        return {
          digest: inspections === 1 ? records[0].digest : digest('f'),
          status: 'present',
        };
      },
      publishTag: async () => {
        assert.fail('An initially identical tag must not be republished.');
      },
    }),
    /final release image tag set failed digest verification/
  );
});

test('uses scoped GHCR authorization and accepts only canonical digest headers', async () => {
  const { records } = fixture();
  const calls = [];
  const inspector = createGhcrTagInspector({
    actor: 'github-actions[bot]',
    token: 'sensitive-token',
    fetchImplementation: async (url, options) => {
      calls.push({ options, url: String(url) });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ token: 'scoped-token' }), {
          status: 200,
        });
      }
      return new Response(null, {
        headers: { 'docker-content-digest': records[0].digest },
        status: 200,
      });
    },
  });

  assert.deepEqual(await inspector(records[0]), {
    digest: records[0].digest,
    status: 'present',
  });
  assert.match(
    calls[0].url,
    /scope=repository%3Amherzog4%2Fbyok-grid-web%3Apull/u
  );
  assert.equal(calls[1].options.method, 'HEAD');
  assert.equal(calls[1].options.headers.authorization, 'Bearer scoped-token');
});

test('does not expose registry credentials through dependency failures', async () => {
  const secret = 'credential-that-must-stay-private';
  const { records } = fixture();
  const inspector = createGhcrTagInspector({
    actor: 'release-bot',
    token: secret,
    fetchImplementation: async () => {
      throw new Error(`provider failure containing ${secret}`);
    },
  });

  await assert.rejects(inspector(records[0]), (error) => {
    assert.ok(error instanceof ReleaseImageTagsError);
    assert.doesNotMatch(error.message, new RegExp(secret));
    return true;
  });
});

test('distinguishes an absent tag from registry errors and invalid digests', async () => {
  const { records } = fixture();
  async function inspectWithManifestResponse(manifestResponse) {
    let calls = 0;
    const inspector = createGhcrTagInspector({
      actor: 'release-bot',
      token: 'registry-token',
      fetchImplementation: async () => {
        calls += 1;
        return calls === 1
          ? new Response(JSON.stringify({ token: 'scoped-token' }), {
              status: 200,
            })
          : manifestResponse;
      },
    });
    return inspector(records[0]);
  }

  assert.deepEqual(
    await inspectWithManifestResponse(new Response(null, { status: 404 })),
    { status: 'absent' }
  );
  await assert.rejects(
    inspectWithManifestResponse(new Response(null, { status: 503 })),
    /unexpected status/
  );
  await assert.rejects(
    inspectWithManifestResponse(
      new Response(null, {
        headers: { 'docker-content-digest': 'not-a-digest' },
        status: 200,
      })
    ),
    /invalid digest/
  );
});

test('bounds GHCR authorization responses', async () => {
  const { records } = fixture();
  const inspector = createGhcrTagInspector({
    actor: 'release-bot',
    token: 'registry-token',
    fetchImplementation: async () => new Response('x'.repeat(32_769)),
  });

  await assert.rejects(inspector(records[0]), /invalid response/);
});

test('the CLI rejects invalid credentials without printing credential values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'byok-grid-image-tags-cli-'));
  const releaseConfig = JSON.parse(readFileSync('release-images.json', 'utf8'));
  for (const { image, target } of releaseConfig.images) {
    writeFileSync(
      join(directory, `${target}.txt`),
      `ghcr.io/${owner}/${image}@${digest('a')}\n`,
      'utf8'
    );
  }
  const secret = 'cli-secret-that-must-stay-private';
  const result = spawnSync(
    process.execPath,
    [
      'scripts/publish-release-image-tags.mjs',
      '--version',
      version,
      '--digests-dir',
      directory,
      '--owner',
      owner,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        BYOK_GRID_GHCR_ACTOR: `invalid:${secret}`,
        BYOK_GRID_GHCR_TOKEN: secret,
      },
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /GHCR actor identity is invalid/);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, new RegExp(secret));
});
