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
  'authenticated-worker-drain': ['BYOK_GRID_KUBERNETES_WORKER_DRAIN_VERIFIED'],
  'multi-architecture-smoke': ['BYOK_GRID_RELEASE_IMAGE_SMOKE_VERIFIED'],
  'production-capacity': ['BYOK_GRID_PRODUCTION_CAPACITY_VERIFIED'],
  'public-ingress-and-proxy': ['BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED'],
  'reference-deployment': [
    'BYOK_GRID_KUBERNETES_NETWORK_POLICY_ENFORCEMENT_VERIFIED',
    'BYOK_GRID_KUBERNETES_RUNTIME_VERIFIED',
  ],
  'remote-libsql-recovery': [
    'BYOK_GRID_REMOTE_LIBSQL_DRILL_PREPARED',
    'BYOK_GRID_REMOTE_LIBSQL_RESTORE_VERIFIED',
  ],
  'smtp-delivery': ['BYOK_GRID_SMTP_DELIVERY_AUTHENTICATION_VERIFIED'],
};

describe('production evidence verifier', () => {
  it('accepts the exact stable promotion evidence contract', () => {
    const verified = verifyProductionEvidence(manifest(), {
      expectedCandidateCommit: CANDIDATE_COMMIT,
      expectedReleaseVersion: '0.1.0',
      now: NOW,
    });
    assert.deepEqual(verified, {
      candidateCommit: CANDIDATE_COMMIT,
      candidateVersion: '0.1.0-rc.1',
      evidenceCount: REQUIRED_PRODUCTION_EVIDENCE_IDS.length,
      observationHours: 24,
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
    unexpected.debug = true;
    assert.throws(
      () => verifyProductionEvidence(unexpected, { now: NOW }),
      /missing or unexpected fields/u
    );
  });

  it('binds drill-backed gates to their exact structured markers', () => {
    const missingMarker = manifest();
    findEvidence(missingMarker, 'production-capacity').markers = [];
    assert.throws(
      () => verifyProductionEvidence(missingMarker, { now: NOW }),
      /incorrect structured markers/u
    );

    const inventedMarker = manifest();
    findEvidence(inventedMarker, 'release-assets').markers = ['PASSED'];
    assert.throws(
      () => verifyProductionEvidence(inventedMarker, { now: NOW }),
      /incorrect structured markers/u
    );
  });

  it('requires a completed 24-hour blocker-free observation window', () => {
    const short = manifest();
    short.observationWindow.endedAt = '2026-08-01T23:59:59.999Z';
    assert.throws(
      () => verifyProductionEvidence(short, { now: NOW }),
      /at least 24 hours/u
    );

    const blocked = manifest();
    blocked.observationWindow.unresolvedBlockers = 1;
    assert.throws(
      () => verifyProductionEvidence(blocked, { now: NOW }),
      /zero unresolved blockers/u
    );

    const earlyAcceptance = manifest();
    earlyAcceptance.acceptance.acceptedAt = '2026-08-01T23:00:00.000Z';
    assert.throws(
      () => verifyProductionEvidence(earlyAcceptance, { now: NOW }),
      /must follow observation/u
    );

    const lateRollback = manifest();
    lateRollback.rollback.testedAt = '2026-08-02T00:30:00.000Z';
    assert.throws(
      () => verifyProductionEvidence(lateRollback, { now: NOW }),
      /during the candidate window/u
    );
  });

  it('binds the promoted prerelease, release version, and candidate commit', () => {
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
    credentialUrl.rollback.reference =
      'https://operator:secret@example.com/evidence/rollback';
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
    noncanonicalTime.rollback.testedAt = '2026-08-01T12:00:00Z';
    assert.throws(
      () => verifyProductionEvidence(noncanonicalTime, { now: NOW }),
      /canonical UTC timestamp/u
    );

    const future = manifest();
    future.acceptance.acceptedAt = '2026-08-06T00:00:00.000Z';
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
        observationHours: 24,
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

  it('is a mandatory stable-only branch of release verification', () => {
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
    assert.doesNotThrow(() =>
      assertStablePromotionPaths(
        [
          'SECURITY.md',
          'deploy/helm/byok-grid/Chart.yaml',
          'docs/PRODUCTION_READINESS.md',
          'docs/evidence/0.1.0-production.json',
          'package-lock.json',
          'package.json',
        ],
        '0.1.0'
      )
    );
    assert.throws(
      () =>
        assertStablePromotionPaths(
          ['apps/web/src/app/page.tsx', 'docs/evidence/0.1.0-production.json'],
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
          [
            'deploy/helm/byok-grid/Chart.yaml',
            'docs/evidence/0.1.0-production.json',
            'package-lock.json',
            'package.json',
          ],
          '0.1.0'
        ),
      /exact release-only file set/u
    );
  });
});

function manifest() {
  return {
    acceptance: {
      acceptedAt: '2026-08-02T01:00:00.000Z',
      operatorId: 'github:release-operator',
      reference: 'https://example.com/evidence/operator-acceptance',
    },
    candidate: {
      commit: CANDIDATE_COMMIT,
      digestManifestSha256: DIGEST,
      version: '0.1.0-rc.1',
    },
    evidence: REQUIRED_PRODUCTION_EVIDENCE_IDS.map((id) => evidence(id)),
    observationWindow: {
      endedAt: '2026-08-02T00:00:00.000Z',
      startedAt: '2026-08-01T00:00:00.000Z',
      unresolvedBlockers: 0,
    },
    releaseVersion: '0.1.0',
    rollback: {
      artifactSha256: DIGEST,
      reference: 'https://example.com/evidence/rollback',
      testedAt: '2026-08-01T12:00:00.000Z',
    },
    schemaVersion: 1,
    supportedOptionalAdapters: [],
  };
}

function evidence(id) {
  return {
    artifactSha256: DIGEST,
    id,
    markers: EXPECTED_MARKERS[id] ?? [],
    reference: `https://example.com/evidence/${id}`,
    verifiedAt:
      id === 'observation-window'
        ? '2026-08-02T00:00:00.000Z'
        : '2026-08-01T12:00:00.000Z',
  };
}

function findEvidence(value, id) {
  return value.evidence.find((record) => record.id === id);
}
