import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  NATIVE_IMAGE_SMOKE_HOST_MARKER,
  NATIVE_MULTI_ARCH_IMAGE_SMOKE_MARKER,
  NativeImageSmokeError,
  canonicalJson,
  collectNativeImageSmokeEvidence,
  runtimePlatform,
  verifyNativeImageSmokeBundle,
  verifyNativeImageSmokeBundleFiles,
} from './native-image-smoke-lib.mjs';
import { RELEASE_IMAGE_SMOKE_MARKER } from './verify-release-image-smoke-lib.mjs';

const candidateCommit = 'a'.repeat(40);
const releaseVersion = '0.1.0-rc.1';
const releaseConfig = JSON.parse(readFileSync('release-images.json', 'utf8'));
const digestByTarget = new Map(
  releaseConfig.images.map(({ target }, index) => [
    target,
    `sha256:${String(index + 1).repeat(64)}`,
  ])
);
const digestManifest = `${releaseConfig.images
  .map(
    ({ image, target }) =>
      `ghcr.io/mherzog4/${image}@${digestByTarget.get(target)}`
  )
  .sort(compareAscii)
  .join('\n')}\n`;
const targets = releaseConfig.images
  .map(({ target }) => target)
  .sort(compareAscii);
const releaseSmokeManifest = `${targets
  .flatMap((target) =>
    ['linux/amd64', 'linux/arm64'].map((platform) =>
      JSON.stringify(smokeRecord(target, platform))
    )
  )
  .join('\n')}\n`;

test('maps only native Linux amd64 and arm64 runtimes', () => {
  assert.equal(runtimePlatform('linux', 'x64'), 'linux/amd64');
  assert.equal(runtimePlatform('linux', 'arm64'), 'linux/arm64');
  assert.throws(() => runtimePlatform('darwin', 'arm64'), /Linux host/u);
  assert.throws(() => runtimePlatform('linux', 'riscv64'), /amd64 or arm64/u);
});

test('collects every digest with the fixed native Docker boundary', () => {
  const calls = [];
  const evidence = collectNativeImageSmokeEvidence({
    candidateCommit,
    digestManifest,
    hostPlatform: 'linux/amd64',
    now: new Date('2026-08-04T12:00:00.000Z'),
    releaseConfig,
    releaseVersion,
    runCommand(command, args, options) {
      calls.push({ args, command, options });
      if (args[0] === 'version') {
        return {
          status: 0,
          stdout:
            '{"architecture":"amd64","operatingSystem":"linux","serverVersion":"28.5.1"}\n',
        };
      }
      const reference = args.at(-2);
      const target = targetForReference(reference);
      return {
        status: 0,
        stdout: `${JSON.stringify({ marker: 'BYOK_GRID_IMAGE_SMOKE_READY', target })}\n`,
      };
    },
  });

  assert.equal(evidence.marker, NATIVE_IMAGE_SMOKE_HOST_MARKER);
  assert.equal(evidence.platform, 'linux/amd64');
  assert.equal(evidence.records.length, 7);
  assert.equal(calls.length, 8);
  assert.deepEqual(calls[0].args, [
    'version',
    '--format',
    '{"architecture":{{json .Server.Arch}},"operatingSystem":{{json .Server.Os}},"serverVersion":{{json .Server.Version}}}',
  ]);
  for (const call of calls.slice(1)) {
    assert.deepEqual(call.args, [
      'run',
      '--rm',
      '--pull=always',
      '--platform',
      'linux/amd64',
      '--network=none',
      '--read-only',
      '--cap-drop=ALL',
      '--security-opt=no-new-privileges',
      '--pids-limit=64',
      call.args[10],
      '--image-smoke',
    ]);
    assert.match(call.args[10], /@sha256:[0-9a-f]{64}$/u);
    assert.equal(call.options.timeout, 30_000);
  }
});

test('rejects emulation or Docker identity drift before running images', () => {
  let runs = 0;
  assert.throws(
    () =>
      collectNativeImageSmokeEvidence({
        candidateCommit,
        digestManifest,
        hostPlatform: 'linux/arm64',
        releaseConfig,
        releaseVersion,
        runCommand(_command, args) {
          if (args[0] === 'run') runs += 1;
          return {
            status: 0,
            stdout:
              '{"architecture":"amd64","operatingSystem":"linux","serverVersion":"28.5.1"}\n',
          };
        },
      }),
    /does not match the native host architecture/u
  );
  assert.equal(runs, 0);
});

test('fails without exposing Docker provider diagnostics', () => {
  const secret = 'registry-token-provider-detail';
  assert.throws(
    () =>
      collectNativeImageSmokeEvidence({
        candidateCommit,
        digestManifest,
        hostPlatform: 'linux/amd64',
        releaseConfig,
        releaseVersion,
        runCommand(_command, args) {
          if (args[0] === 'version') {
            return {
              status: 0,
              stdout:
                '{"architecture":"amd64","operatingSystem":"linux","serverVersion":"28.5.1"}\n',
            };
          }
          throw new Error(secret);
        },
      }),
    (error) => {
      assert.ok(error instanceof NativeImageSmokeError);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    }
  );
});

test('verifies the exact native two-host and attested release record set', () => {
  const amd64 = hostEvidence('linux/amd64', '2026-08-04T12:00:00.000Z');
  const arm64 = hostEvidence('linux/arm64', '2026-08-04T12:05:00.000Z');
  const verified = verifyNativeImageSmokeBundle({
    candidateCommit,
    digestManifest,
    hostEvidence: [arm64, amd64],
    now: new Date('2026-08-04T12:10:00.000Z'),
    releaseConfig,
    releaseSmokeManifest,
    releaseVersion,
  });

  assert.equal(verified.marker, NATIVE_MULTI_ARCH_IMAGE_SMOKE_MARKER);
  assert.equal(verified.records, 14);
  assert.equal(verified.releaseSmokeMarker, RELEASE_IMAGE_SMOKE_MARKER);
  assert.deepEqual(
    verified.hostEvidence.map(({ platform }) => platform),
    ['linux/amd64', 'linux/arm64']
  );
  assert.equal(
    verified.digestManifestSha256,
    createHash('sha256').update(digestManifest).digest('hex')
  );
});

test('rejects duplicate hosts, release drift, and stale collection pairs', () => {
  const amd64 = hostEvidence('linux/amd64', '2026-08-04T12:00:00.000Z');
  const arm64 = hostEvidence('linux/arm64', '2026-08-04T12:05:00.000Z');
  const base = {
    candidateCommit,
    digestManifest,
    hostEvidence: [amd64, arm64],
    now: new Date('2026-08-04T12:10:00.000Z'),
    releaseConfig,
    releaseSmokeManifest,
    releaseVersion,
  };

  assert.throws(
    () =>
      verifyNativeImageSmokeBundle({ ...base, hostEvidence: [amd64, amd64] }),
    /one host for each architecture/u
  );
  const drifted = structuredClone(arm64);
  drifted.records[0].digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () =>
      verifyNativeImageSmokeBundle({ ...base, hostEvidence: [amd64, drifted] }),
    /does not match its release image/u
  );
  assert.throws(
    () =>
      verifyNativeImageSmokeBundle({
        ...base,
        hostEvidence: [
          amd64,
          hostEvidence('linux/arm64', '2026-08-05T12:00:00.001Z'),
        ],
        now: new Date('2026-08-05T12:05:00.000Z'),
      }),
    /within 24 hours/u
  );
});

test('reads only canonical bounded regular host evidence files', () => {
  const root = fixtureDirectory();
  try {
    const result = verifyNativeImageSmokeBundleFiles({
      amd64EvidencePath: join(root, 'amd64.json'),
      arm64EvidencePath: join(root, 'arm64.json'),
      candidateCommit,
      digestManifestPath: join(root, 'IMAGE_DIGESTS.txt'),
      now: new Date('2026-08-04T12:10:00.000Z'),
      releaseConfigPath: join(root, 'release-images.json'),
      releaseSmokeManifestPath: join(root, 'IMAGE_SMOKE.jsonl'),
      releaseVersion,
    });
    assert.equal(result.records, 14);

    writeFileSync(
      join(root, 'noncanonical.json'),
      `${JSON.stringify(hostEvidence('linux/amd64', '2026-08-04T12:00:00.000Z'), null, 2)}\n`,
      'utf8'
    );
    assert.throws(
      () =>
        verifyNativeImageSmokeBundleFiles({
          amd64EvidencePath: join(root, 'noncanonical.json'),
          arm64EvidencePath: join(root, 'arm64.json'),
          candidateCommit,
          digestManifestPath: join(root, 'IMAGE_DIGESTS.txt'),
          releaseConfigPath: join(root, 'release-images.json'),
          releaseSmokeManifestPath: join(root, 'IMAGE_SMOKE.jsonl'),
          releaseVersion,
        }),
      /canonical JSON/u
    );
    symlinkSync(join(root, 'amd64.json'), join(root, 'linked.json'));
    assert.throws(
      () =>
        verifyNativeImageSmokeBundleFiles({
          amd64EvidencePath: join(root, 'linked.json'),
          arm64EvidencePath: join(root, 'arm64.json'),
          candidateCommit,
          digestManifestPath: join(root, 'IMAGE_DIGESTS.txt'),
          releaseConfigPath: join(root, 'release-images.json'),
          releaseSmokeManifestPath: join(root, 'IMAGE_SMOKE.jsonl'),
          releaseVersion,
        }),
      /could not be read/u
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('the public verifier emits one safe result and creates evidence once', () => {
  const root = fixtureDirectory();
  const output = join(root, 'combined.json');
  try {
    const result = runVerifier(root, output);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      hosts: 2,
      marker: NATIVE_MULTI_ARCH_IMAGE_SMOKE_MARKER,
      records: 14,
      releaseVersion,
    });
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).records, 14);
    assert.equal(lstatSync(output).mode & 0o777, 0o600);

    const second = runVerifier(root, output);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /could not be created/u);
    assert.doesNotMatch(second.stderr, new RegExp(root));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test('the public collector rejects a different checkout before Docker access', () => {
  const privatePath = '/operator/private-registry-token/IMAGE_DIGESTS.txt';
  const result = spawnSync(
    process.execPath,
    [
      'scripts/collect-native-image-smoke.mjs',
      '--version',
      releaseVersion,
      '--candidate',
      'b'.repeat(40),
      '--digest-manifest',
      privatePath,
      '--output',
      '/operator/native-output.json',
    ],
    { encoding: 'utf8' }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exact clean candidate checkout/u);
  assert.doesNotMatch(result.stderr, /private-registry-token|native-output/u);
});

function hostEvidence(platform, verifiedAt) {
  const architecture = platform === 'linux/amd64' ? 'amd64' : 'arm64';
  return {
    candidateCommit,
    digestManifestSha256: createHash('sha256')
      .update(digestManifest)
      .digest('hex'),
    docker: {
      architecture,
      operatingSystem: 'linux',
      serverVersion: '28.5.1',
    },
    marker: NATIVE_IMAGE_SMOKE_HOST_MARKER,
    platform,
    records: targets.map((target) => smokeRecord(target, platform)),
    releaseVersion,
    schemaVersion: 1,
    verifiedAt,
  };
}

function smokeRecord(target, platform) {
  return {
    digest: digestByTarget.get(target),
    marker: RELEASE_IMAGE_SMOKE_MARKER,
    platform,
    target,
  };
}

function targetForReference(reference) {
  const image = reference.match(/\/(?<image>byok-grid-[a-z0-9-]+)@/u)?.groups
    ?.image;
  return releaseConfig.images.find((entry) => entry.image === image)?.target;
}

function fixtureDirectory() {
  const root = mkdtempSync(join(tmpdir(), 'byok-grid-native-smoke-'));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'IMAGE_DIGESTS.txt'), digestManifest, 'utf8');
  writeFileSync(join(root, 'IMAGE_SMOKE.jsonl'), releaseSmokeManifest, 'utf8');
  writeFileSync(
    join(root, 'release-images.json'),
    `${JSON.stringify(releaseConfig)}\n`,
    'utf8'
  );
  writeFileSync(
    join(root, 'amd64.json'),
    canonicalJson(hostEvidence('linux/amd64', '2026-08-04T12:00:00.000Z')),
    { encoding: 'utf8', mode: 0o600 }
  );
  writeFileSync(
    join(root, 'arm64.json'),
    canonicalJson(hostEvidence('linux/arm64', '2026-08-04T12:05:00.000Z')),
    { encoding: 'utf8', mode: 0o600 }
  );
  return root;
}

function runVerifier(root, output) {
  return spawnSync(
    process.execPath,
    [
      'scripts/verify-native-image-smoke.mjs',
      '--version',
      releaseVersion,
      '--candidate',
      candidateCommit,
      '--digest-manifest',
      join(root, 'IMAGE_DIGESTS.txt'),
      '--release-smoke',
      join(root, 'IMAGE_SMOKE.jsonl'),
      '--amd64-evidence',
      join(root, 'amd64.json'),
      '--arm64-evidence',
      join(root, 'arm64.json'),
      '--output',
      output,
    ],
    { encoding: 'utf8' }
  );
}

function compareAscii(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
