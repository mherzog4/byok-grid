import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  IMAGE_SMOKE_READY_MARKER,
  RELEASE_IMAGE_SMOKE_MARKER,
  verifyReleaseImageSmoke,
  verifyReleaseImageSmokeEvidence,
} from './verify-release-image-smoke-lib.mjs';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const releaseImages = JSON.parse(readFileSync('release-images.json', 'utf8'));
const releaseTargets = releaseImages.images.map((image) => image.target);

describe('multi-architecture release image smoke', () => {
  it('binds an exact image response to target, platform, and digest', () => {
    assert.deepEqual(
      verifyReleaseImageSmoke(imageResponse('web'), {
        expectedDigest: DIGEST,
        expectedPlatform: 'linux/amd64',
        expectedTarget: 'web',
        releaseTargets,
      }),
      {
        digest: DIGEST,
        marker: RELEASE_IMAGE_SMOKE_MARKER,
        platform: 'linux/amd64',
        target: 'web',
      }
    );
  });

  it('revalidates a packaged outer evidence record', () => {
    const evidence = {
      digest: DIGEST,
      marker: RELEASE_IMAGE_SMOKE_MARKER,
      platform: 'linux/arm64',
      target: 'web',
    };
    assert.deepEqual(
      verifyReleaseImageSmokeEvidence(evidence, {
        expectedDigest: DIGEST,
        expectedPlatform: 'linux/arm64',
        expectedTarget: 'web',
        releaseTargets,
      }),
      evidence
    );
    assert.throws(
      () =>
        verifyReleaseImageSmokeEvidence(
          { ...evidence, note: 'untrusted' },
          {
            expectedDigest: DIGEST,
            expectedPlatform: 'linux/arm64',
            expectedTarget: 'web',
            releaseTargets,
          }
        ),
      /unexpected fields/u
    );
    assert.throws(
      () =>
        verifyReleaseImageSmokeEvidence(
          { ...evidence, platform: 'linux/amd64' },
          {
            expectedDigest: DIGEST,
            expectedPlatform: 'linux/arm64',
            expectedTarget: 'web',
            releaseTargets,
          }
        ),
      /does not match/u
    );
  });

  it('rejects malformed, mismatched, or expanded image output', () => {
    for (const raw of [
      'not-json',
      JSON.stringify({ marker: IMAGE_SMOKE_READY_MARKER, target: 'worker' }),
      JSON.stringify({
        debug: true,
        marker: IMAGE_SMOKE_READY_MARKER,
        target: 'web',
      }),
    ]) {
      assert.throws(
        () =>
          verifyReleaseImageSmoke(raw, {
            expectedDigest: DIGEST,
            expectedPlatform: 'linux/amd64',
            expectedTarget: 'web',
            releaseTargets,
          }),
        /valid JSON|expected release target|unexpected fields/u
      );
    }
  });

  it('rejects unknown targets, mutable digests, and unsupported platforms', () => {
    assert.throws(
      () =>
        verifyReleaseImageSmoke(imageResponse('unknown'), {
          expectedDigest: DIGEST,
          expectedPlatform: 'linux/amd64',
          expectedTarget: 'unknown',
          releaseTargets,
        }),
      /not a unique release target/u
    );
    assert.throws(
      () =>
        verifyReleaseImageSmoke(imageResponse('web'), {
          expectedDigest: 'latest',
          expectedPlatform: 'linux/amd64',
          expectedTarget: 'web',
          releaseTargets,
        }),
      /lowercase sha256 digest/u
    );
    assert.throws(
      () =>
        verifyReleaseImageSmoke(imageResponse('web'), {
          expectedDigest: DIGEST,
          expectedPlatform: 'linux/s390x',
          expectedTarget: 'web',
          releaseTargets,
        }),
      /linux\/amd64 or linux\/arm64/u
    );
  });

  it('emits one bounded evidence record through the stdin CLI', () => {
    const result = spawnSync(
      process.execPath,
      [
        'scripts/verify-release-image-smoke.mjs',
        'workflow-worker',
        'linux/arm64',
        DIGEST,
      ],
      { encoding: 'utf8', input: imageResponse('workflow-worker') }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      digest: DIGEST,
      marker: RELEASE_IMAGE_SMOKE_MARKER,
      platform: 'linux/arm64',
      target: 'workflow-worker',
    });
  });

  it('does not echo untrusted image output on CLI failure', () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/verify-release-image-smoke.mjs', 'web', 'linux/amd64', DIGEST],
      { encoding: 'utf8', input: 'operator-secret-smoke-output' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must be valid JSON/u);
    assert.doesNotMatch(result.stderr, /operator-secret/u);
    assert.equal(result.stdout, '');
  });

  it('executes every shell-owned image entrypoint without configuration', () => {
    const entries = [
      ['web', 'scripts/container/web-entrypoint.sh'],
      ['workflow-worker', 'scripts/container/workflow-worker-entrypoint.sh'],
      ['migration', 'scripts/container/migration-entrypoint.sh'],
      ['maintenance', 'scripts/container/maintenance-entrypoint.sh'],
    ];
    for (const [target, path] of entries) {
      const result = spawnSync('sh', [path, '--image-smoke'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH },
      });
      assert.equal(result.status, 0, `${target}: ${result.stderr}`);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        marker: IMAGE_SMOKE_READY_MARKER,
        target,
      });
    }
  });

  it('loads the analytics projector production module graph in smoke mode', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'apps/analytics-projector/src/index.ts',
        '--image-smoke',
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } }
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      marker: IMAGE_SMOKE_READY_MARKER,
      target: 'analytics-projector',
    });
  });

  it('keeps the release matrix and workflow smoke contract closed', () => {
    assert.equal(releaseImages.schemaVersion, 1);
    assert.deepEqual(releaseTargets.sort(), [
      'airbyte-destination',
      'analytics-projector',
      'connector-runner',
      'maintenance',
      'migration',
      'web',
      'workflow-worker',
    ]);
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    for (const fragment of [
      'set -euo pipefail',
      'for platform in linux/amd64 linux/arm64',
      '--pull=always',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=64',
      '--image-smoke',
      'scripts/verify-release-image-smoke.mjs',
      'release-smoke-${{ matrix.target }}',
      'pattern: release-smoke-*',
      '--smoke-dir release-smoke',
    ]) {
      assert.ok(workflow.includes(fragment), `missing workflow: ${fragment}`);
    }
    assert.doesNotMatch(workflow, /smoke_output=/u);

    const dockerfile = readFileSync('Dockerfile', 'utf8');
    assert.match(
      dockerfile,
      /FROM \$\{NODE_IMAGE\} AS worker-runtime[\s\S]*?ENV TSX_DISABLE_CACHE=1/u
    );
  });
});

function imageResponse(target) {
  return JSON.stringify({ marker: IMAGE_SMOKE_READY_MARKER, target });
}
