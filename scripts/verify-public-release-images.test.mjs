import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  createAnonymousGhcrTagInspector,
  PUBLIC_RELEASE_IMAGES_MARKER,
  verifyPublicReleaseImages,
} from './verify-public-release-images-lib.mjs';

const VERSION = '0.1.0-rc.1';

function digest(character) {
  return `sha256:${character.repeat(64)}`;
}

function records() {
  return [
    'web',
    'workflow-worker',
    'migration',
    'maintenance',
    'connector-runner',
    'airbyte-destination',
    'analytics-projector',
  ].map((name, index) => {
    const repository = `ghcr.io/mherzog4/byok-grid-${name}`;
    const immutableDigest = digest(String(index + 1));
    return {
      destination: `${repository}:${VERSION}`,
      digest: immutableDigest,
      image: `byok-grid-${name}`,
      repository,
      source: `${repository}@${immutableDigest}`,
      target: name,
      version: VERSION,
    };
  });
}

test('accepts the exact seven anonymously readable release images', async () => {
  const input = records();
  const result = await verifyPublicReleaseImages({
    inspectPublicTag: async (record) => ({
      digest: record.digest,
      status: 'present',
    }),
    records: input,
  });

  assert.deepEqual(result, {
    anonymous: true,
    images: 7,
    marker: PUBLIC_RELEASE_IMAGES_MARKER,
    version: VERSION,
  });
});

test('rejects incomplete, duplicate, absent, and drifted image sets', async () => {
  await assert.rejects(
    verifyPublicReleaseImages({
      inspectPublicTag: async () => ({ status: 'absent' }),
      records: records().slice(0, 6),
    }),
    /exact seven-image inventory/u
  );

  const duplicate = records();
  duplicate[6] = { ...duplicate[0] };
  await assert.rejects(
    verifyPublicReleaseImages({
      inspectPublicTag: async (record) => ({
        digest: record.digest,
        status: 'present',
      }),
      records: duplicate,
    }),
    /must be unique/u
  );

  await assert.rejects(
    verifyPublicReleaseImages({
      inspectPublicTag: async () => ({ status: 'absent' }),
      records: records(),
    }),
    /not anonymously readable/u
  );

  await assert.rejects(
    verifyPublicReleaseImages({
      inspectPublicTag: async () => ({
        digest: digest('f'),
        status: 'present',
      }),
      records: records(),
    }),
    /not anonymously readable/u
  );
});

test('uses anonymous bounded authorization and verifies tag plus digest', async () => {
  const [record] = records();
  const calls = [];
  const inspect = createAnonymousGhcrTagInspector({
    fetchImplementation: async (url, options) => {
      calls.push({ options, url: String(url) });
      if (String(url).startsWith('https://ghcr.io/token?')) {
        return new Response('{"token":"anonymous-bearer"}', { status: 200 });
      }
      return new Response(null, {
        headers: { 'docker-content-digest': record.digest },
        status: 200,
      });
    },
  });

  assert.deepEqual(await inspect(record), {
    digest: record.digest,
    status: 'present',
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.match(
    calls[0].url,
    /scope=repository%3Amherzog4%2Fbyok-grid-web%3Apull/u
  );
  assert.equal(
    calls[1].options.headers.authorization,
    'Bearer anonymous-bearer'
  );
  assert.equal(
    calls[2].options.headers.authorization,
    'Bearer anonymous-bearer'
  );
  assert.ok(calls.some(({ url }) => url.endsWith(`/manifests/${VERSION}`)));
  assert.ok(
    calls.some(({ url }) =>
      url.endsWith(`/manifests/${encodeURIComponent(record.digest)}`)
    )
  );
});

test('fails closed for private images, oversized tokens, and provider errors', async () => {
  const [record] = records();
  const privateInspector = createAnonymousGhcrTagInspector({
    fetchImplementation: async (url) =>
      String(url).startsWith('https://ghcr.io/token?')
        ? new Response('{"token":"anonymous-bearer"}', { status: 200 })
        : new Response(null, { status: 401 }),
  });
  await assert.rejects(privateInspector(record), /not anonymously readable/u);

  const oversized = createAnonymousGhcrTagInspector({
    fetchImplementation: async () =>
      new Response(`{"token":"${'a'.repeat(32_769)}"}`, { status: 200 }),
  });
  await assert.rejects(oversized(record), /exceeded the size limit/u);

  const secret = 'provider-secret-never-log';
  const failed = createAnonymousGhcrTagInspector({
    fetchImplementation: async () => {
      throw new Error(`provider leaked ${secret}`);
    },
  });
  await assert.rejects(failed(record), (error) => {
    assert.doesNotMatch(error.message, new RegExp(secret, 'u'));
    return true;
  });
});

test('CLI rejects invalid input before any registry request', () => {
  const secret = 'environment-secret-never-log';
  const result = spawnSync(
    process.execPath,
    [
      'scripts/verify-public-release-images.mjs',
      '--version',
      VERSION,
      '--digests-dir',
      'missing-directory',
      '--owner',
      'mherzog4',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, BYOK_GRID_GHCR_TOKEN: secret },
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /required release image path is unavailable/u);
  assert.doesNotMatch(result.stderr, new RegExp(secret, 'u'));
});
