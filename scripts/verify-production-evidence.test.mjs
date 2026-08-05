import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  PRODUCTION_EVIDENCE_MARKER,
  REQUIRED_PRODUCTION_EVIDENCE_IDS,
  assertStablePromotionPaths,
  verifyProductionEvidence,
  verifyProductionEvidenceFile,
} from './verify-production-evidence-lib.mjs';

const CANDIDATE_COMMIT = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);
const NOW = new Date('2026-08-05T00:00:00.000Z');
const EXPECTED_MARKERS = {
  'multi-architecture-smoke': ['BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED'],
  'release-assets': [
    'BYOK_GRID_PUBLISHED_RELEASE_VERIFIED',
    'BYOK_GRID_RELEASE_BUNDLE_VERIFIED',
  ],
  'release-tag-protection': ['BYOK_GRID_RELEASE_TAG_PROTECTION_VERIFIED'],
  'single-node-runtime': [
    'BYOK_GRID_DRAIN_DRILL_PASSED',
    'BYOK_GRID_DRAIN_SIGNAL_COMPLETE',
    'BYOK_GRID_WEB_DRAIN_DRILL_PASSED',
  ],
};

describe('production evidence verifier', () => {
  it('accepts the default single-node stable evidence contract', () => {
    const verified = verifyProductionEvidence(manifest(), {
      expectedCandidateCommit: CANDIDATE_COMMIT,
      expectedReleaseVersion: '0.1.0',
      now: NOW,
    });
    assert.deepEqual(verified, {
      candidateCommit: CANDIDATE_COMMIT,
      candidateVersion: '0.1.0-rc.3',
      evidenceCount: REQUIRED_PRODUCTION_EVIDENCE_IDS.length,
      operatorId: 'github:release-operator',
      releaseVersion: '0.1.0',
      supportedOptionalAdapters: [],
    });
    assert.equal(
      PRODUCTION_EVIDENCE_MARKER,
      'BYOK_GRID_PRODUCTION_EVIDENCE_VERIFIED'
    );
  });

  it('requires supported optional adapters to carry their own E2E evidence', () => {
    const value = manifest();
    value.supportedOptionalAdapters = ['airbyte', 'clickhouse'];
    value.evidence.push(evidence('airbyte-e2e'), evidence('clickhouse-e2e'));
    const verified = verifyProductionEvidence(value, { now: NOW });
    assert.equal(
      verified.evidenceCount,
      REQUIRED_PRODUCTION_EVIDENCE_IDS.length + 2
    );

    const missing = structuredClone(value);
    missing.evidence.pop();
    assert.throws(
      () => verifyProductionEvidence(missing, { now: NOW }),
      /incomplete gate set/u
    );

    const unsorted = structuredClone(value);
    unsorted.supportedOptionalAdapters = ['clickhouse', 'airbyte'];
    assert.throws(
      () => verifyProductionEvidence(unsorted, { now: NOW }),
      /sorted unique list/u
    );
  });

  it('rejects missing, duplicate, and unexpected evidence identities', () => {
    const legacySchema = manifest();
    legacySchema.schemaVersion = 1;
    assert.throws(
      () => verifyProductionEvidence(legacySchema, { now: NOW }),
      /schemaVersion must be 2/u
    );

    const missing = manifest();
    missing.evidence.pop();
    assert.throws(
      () => verifyProductionEvidence(missing, { now: NOW }),
      /incomplete gate set/u
    );

    const duplicate = manifest();
    duplicate.evidence[0] = structuredClone(duplicate.evidence[1]);
    assert.throws(
      () => verifyProductionEvidence(duplicate, { now: NOW }),
      /missing or duplicate gate IDs/u
    );

    const unexpected = manifest();
    unexpected.observationWindow = {};
    assert.throws(
      () => verifyProductionEvidence(unexpected, { now: NOW }),
      /missing or unexpected fields/u
    );
  });

  it('binds shipped-runtime gates to exact structured markers', () => {
    const incompleteRuntime = manifest();
    findEvidence(incompleteRuntime, 'single-node-runtime').markers.pop();
    assert.throws(
      () => verifyProductionEvidence(incompleteRuntime, { now: NOW }),
      /incorrect structured markers/u
    );

    const expandedArchitectureClaim = manifest();
    findEvidence(
      expandedArchitectureClaim,
      'multi-architecture-smoke'
    ).markers = [
      'BYOK_GRID_NATIVE_MULTI_ARCH_IMAGE_SMOKE_VERIFIED',
      'BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED',
    ];
    assert.throws(
      () => verifyProductionEvidence(expandedArchitectureClaim, { now: NOW }),
      /incorrect structured markers/u
    );

    const incompleteRelease = manifest();
    findEvidence(incompleteRelease, 'release-assets').markers = [
      'BYOK_GRID_RELEASE_BUNDLE_VERIFIED',
    ];
    assert.throws(
      () => verifyProductionEvidence(incompleteRelease, { now: NOW }),
      /incorrect structured markers/u
    );

    const missingProtection = manifest();
    findEvidence(missingProtection, 'release-tag-protection').markers = [];
    assert.throws(
      () => verifyProductionEvidence(missingProtection, { now: NOW }),
      /incorrect structured markers/u
    );

    const inventedBackupMarker = manifest();
    findEvidence(inventedBackupMarker, 'sqlite-backup-restore').markers = [
      'PASSED',
    ];
    assert.throws(
      () => verifyProductionEvidence(inventedBackupMarker, { now: NOW }),
      /incorrect structured markers/u
    );
  });

  it('requires operator acceptance after all retained evidence', () => {
    const earlyAcceptance = manifest();
    earlyAcceptance.acceptance.acceptedAt = '2026-08-03T23:59:59.999Z';
    assert.throws(
      () => verifyProductionEvidence(earlyAcceptance, { now: NOW }),
      /after operator acceptance/u
    );

    const futureAcceptance = manifest();
    futureAcceptance.acceptance.acceptedAt = '2026-08-06T00:00:00.000Z';
    assert.throws(
      () => verifyProductionEvidence(futureAcceptance, { now: NOW }),
      /cannot be in the future/u
    );
  });

  it('binds the promoted prerelease, stable version, and candidate commit', () => {
    const wrongCandidate = manifest();
    wrongCandidate.candidate.version = '0.2.0-rc.1';
    assert.throws(
      () => verifyProductionEvidence(wrongCandidate, { now: NOW }),
      /same stable version/u
    );

    assert.throws(
      () =>
        verifyProductionEvidence(manifest(), {
          expectedCandidateCommit: 'd'.repeat(40),
          now: NOW,
        }),
      /candidate commit does not match/u
    );
    assert.throws(
      () =>
        verifyProductionEvidence(manifest(), {
          expectedReleaseVersion: '0.2.0',
          now: NOW,
        }),
      /releaseVersion does not match/u
    );
  });

  it('rejects unsafe references, noncanonical timestamps, and future claims', () => {
    const credentialUrl = manifest();
    credentialUrl.evidence[0].reference =
      'https://operator:secret@example.com/evidence/runtime';
    assert.throws(
      () => verifyProductionEvidence(credentialUrl, { now: NOW }),
      /canonical HTTPS URL/u
    );

    const queryUrl = manifest();
    queryUrl.acceptance.reference =
      'https://example.com/evidence/acceptance?token=secret';
    assert.throws(
      () => verifyProductionEvidence(queryUrl, { now: NOW }),
      /canonical HTTPS URL/u
    );

    const noncanonicalTime = manifest();
    noncanonicalTime.evidence[0].verifiedAt = '2026-08-04T00:00:00Z';
    assert.throws(
      () => verifyProductionEvidence(noncanonicalTime, { now: NOW }),
      /canonical UTC timestamp/u
    );

    const future = manifest();
    future.evidence[0].verifiedAt = '2026-08-06T00:00:00.000Z';
    assert.throws(
      () => verifyProductionEvidence(future, { now: NOW }),
      /cannot be in the future/u
    );
  });

  it('reads a bounded regular JSON file and rejects symlinks', () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-evidence-'));
    const path = join(directory, 'production.json');
    const link = join(directory, 'production-link.json');
    try {
      writeFileSync(path, `${JSON.stringify(manifest())}\n`);
      symlinkSync(path, link);
      assert.equal(
        verifyProductionEvidenceFile(path, { now: NOW }).releaseVersion,
        '0.1.0'
      );
      assert.throws(
        () => verifyProductionEvidenceFile(join(directory, 'missing.json')),
        /could not be read/u
      );
      assert.throws(() => verifyProductionEvidenceFile(link), /regular file/u);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('does not expose paths or supplied values through CLI failures', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'byok-grid-production-secret-path-')
    );
    const path = join(directory, 'operator-secret.json');
    try {
      writeFileSync(path, `${JSON.stringify(manifest())}\n`);
      const result = spawnSync(
        process.execPath,
        [
          'scripts/verify-production-evidence.mjs',
          path,
          'secret-version',
          'd'.repeat(40),
        ],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /releaseVersion does not match/u);
      assert.doesNotMatch(result.stderr, /operator-secret|secret-version/u);
      assert.equal(result.stdout, '');
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('emits one bounded success record through the public CLI', () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-evidence-cli-'));
    const path = join(directory, 'production.json');
    try {
      writeFileSync(path, `${JSON.stringify(manifest())}\n`);
      const result = spawnSync(
        process.execPath,
        [
          'scripts/verify-production-evidence.mjs',
          path,
          '0.1.0',
          CANDIDATE_COMMIT,
        ],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, 0);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {
        candidateCommit: CANDIDATE_COMMIT,
        evidenceCount: REQUIRED_PRODUCTION_EVIDENCE_IDS.length,
        marker: PRODUCTION_EVIDENCE_MARKER,
        releaseVersion: '0.1.0',
        supportedOptionalAdapters: [],
      });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('keeps the checked-in template deliberately non-passing', () => {
    const template = JSON.parse(
      readFileSync('docs/evidence/production-release.template.json', 'utf8')
    );
    assert.throws(
      () => verifyProductionEvidence(template, { now: NOW }),
      /canonical stable semantic version/u
    );
  });

  it('remains a mandatory stable-only branch of release verification', () => {
    const source = readFileSync('scripts/verify-release-version.mjs', 'utf8');
    assert.match(source, /if \(expectedPrerelease === 'false'\)/u);
    assert.match(source, /verifyStableProductionEvidence\(requestedVersion\)/u);
    assert.match(source, /docs\/evidence\/\$\{version\}-production\.json/u);
    assert.match(source, /merge-base', '--is-ancestor'/u);
    assert.match(
      source,
      /assertStablePromotionPaths\(changedPaths, version\)/u
    );
    const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
    assert.match(workflow, /fetch-depth: 0/u);
  });

  it('allows only evidence and release metadata after the observed candidate', () => {
    const exactPaths = [
      'SECURITY.md',
      'deploy/helm/byok-grid/Chart.yaml',
      'docs/PRODUCTION_READINESS.md',
      'docs/evidence/0.1.0-production.json',
      'docs/releases/v0.1.0.md',
      'package-lock.json',
      'package.json',
    ];
    assert.doesNotThrow(() => assertStablePromotionPaths(exactPaths, '0.1.0'));
    assert.throws(
      () =>
        assertStablePromotionPaths(
          [...exactPaths, 'apps/web/src/app/page.tsx'],
          '0.1.0'
        ),
      /outside the release-only allowlist/u
    );
    assert.throws(
      () => assertStablePromotionPaths(['package.json'], '0.1.0'),
      /must add its versioned production evidence/u
    );
    assert.throws(
      () =>
        assertStablePromotionPaths(
          exactPaths.filter((path) => path !== 'docs/releases/v0.1.0.md'),
          '0.1.0'
        ),
      /must add its version-bound release notes/u
    );
    assert.throws(
      () =>
        assertStablePromotionPaths(
          exactPaths.filter((path) => path !== 'SECURITY.md'),
          '0.1.0'
        ),
      /exact release-only file set/u
    );
  });
});

function manifest() {
  return {
    acceptance: {
      acceptedAt: '2026-08-04T01:00:00.000Z',
      operatorId: 'github:release-operator',
      reference: 'https://example.com/evidence/operator-acceptance',
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      digestManifestSha256: DIGEST,
      version: '0.1.0-rc.3',
    },
    evidence: REQUIRED_PRODUCTION_EVIDENCE_IDS.map((id) => evidence(id)),
    releaseVersion: '0.1.0',
    schemaVersion: 2,
    supportedOptionalAdapters: [],
  };
}

function evidence(id) {
  return {
    artifactSha256: DIGEST,
    id,
    markers: [...(EXPECTED_MARKERS[id] ?? [])],
    reference: `https://example.com/evidence/${id}`,
    verifiedAt: '2026-08-04T00:00:00.000Z',
  };
}

function findEvidence(value, id) {
  return value.evidence.find((record) => record.id === id);
}
