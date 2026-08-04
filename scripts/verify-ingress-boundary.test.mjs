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
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import {
  INGRESS_BOUNDARY_EVIDENCE_MARKER,
  verifyIngressBoundaryEvidence,
  verifyIngressBoundaryEvidenceFile,
} from './verify-ingress-boundary-lib.mjs';

const COMMIT = 'a'.repeat(40);
const DIGEST = 'b'.repeat(64);
const NOW = new Date('2026-08-05T00:00:00.000Z');

describe('production ingress boundary evidence', () => {
  it('requires matching behavioral probes from two external networks', () => {
    assert.deepEqual(
      verifyIngressBoundaryEvidence(evidence(), {
        expectedCandidateCommit: COMMIT,
        now: NOW,
      }),
      {
        candidateCommit: COMMIT,
        challengeSha256: '9'.repeat(64),
        clientNetworks: 2,
        marker: INGRESS_BOUNDARY_EVIDENCE_MARKER,
        origin: 'https://grid.example.test',
        proxyForwardingMode: 'overwrite',
        verifiedAt: NOW.toISOString(),
      }
    );
  });

  it('rejects repeated networks and candidate or origin drift', () => {
    const duplicate = evidence();
    duplicate.clientProbes[1].networkIdSha256 =
      duplicate.clientProbes[0].networkIdSha256;
    assert.throws(
      () => verifyIngressBoundaryEvidence(duplicate, { now: NOW }),
      /distinct network/u
    );

    const reversed = evidence();
    reversed.clientProbes.reverse();
    assert.throws(
      () => verifyIngressBoundaryEvidence(reversed, { now: NOW }),
      /sorted by network identity/u
    );

    const wrongCommit = evidence();
    wrongCommit.clientProbes[1].candidateCommit = 'c'.repeat(40);
    assert.throws(
      () => verifyIngressBoundaryEvidence(wrongCommit, { now: NOW }),
      /match the candidate and origin/u
    );

    const wrongOrigin = evidence();
    wrongOrigin.clientProbes[1].origin = 'https://other.example.test';
    assert.throws(
      () => verifyIngressBoundaryEvidence(wrongOrigin, { now: NOW }),
      /match the candidate and origin/u
    );

    const wrongChallenge = evidence();
    wrongChallenge.clientProbes[1].challengeSha256 = '8'.repeat(64);
    assert.throws(
      () => verifyIngressBoundaryEvidence(wrongChallenge, { now: NOW }),
      /same shared challenge/u
    );
  });

  it('requires direct denial, sanitized chain proof, and a bounded time window', () => {
    const direct = evidence();
    direct.proxyBoundary.directAccessDenied = false;
    assert.throws(
      () => verifyIngressBoundaryEvidence(direct, { now: NOW }),
      /direct web access denial/u
    );

    const unsafeReference = evidence();
    unsafeReference.proxyBoundary.reference =
      'https://user:secret@evidence.example.test/proxy?token=secret';
    assert.throws(
      () => verifyIngressBoundaryEvidence(unsafeReference, { now: NOW }),
      /credential-free HTTPS/u
    );

    const stale = evidence();
    stale.clientProbes[1].verifiedAt = '2026-08-03T00:00:00.000Z';
    stale.clientProbes[1].checks.applicationRateLimit.observedAt =
      '2026-08-03T00:00:00.000Z';
    stale.clientProbes[1].checks.edgeRateLimit.observedAt =
      '2026-08-03T00:00:00.000Z';
    assert.throws(
      () => verifyIngressBoundaryEvidence(stale, { now: NOW }),
      /24-hour window/u
    );

    const unsynchronized = evidence();
    unsynchronized.clientProbes[1].checks.applicationRateLimit.observedAt =
      '2026-08-04T20:15:10.001Z';
    unsynchronized.clientProbes[1].checks.edgeRateLimit.observedAt =
      '2026-08-04T20:15:10.001Z';
    unsynchronized.clientProbes[1].verifiedAt = '2026-08-04T20:15:10.001Z';
    assert.throws(
      () => verifyIngressBoundaryEvidence(unsynchronized, { now: NOW }),
      /same five-second window/u
    );
  });

  it('reads only a bounded regular JSON file', () => {
    const directory = mkdtempSync(
      join(tmpdir(), 'byok-grid-ingress-evidence-')
    );
    try {
      const path = join(directory, 'evidence.json');
      const link = join(directory, 'link.json');
      writeFileSync(path, JSON.stringify(evidence()));
      assert.equal(
        verifyIngressBoundaryEvidenceFile(path, { now: NOW }).marker,
        INGRESS_BOUNDARY_EVIDENCE_MARKER
      );
      symlinkSync(path, link);
      assert.throws(
        () => verifyIngressBoundaryEvidenceFile(link, { now: NOW }),
        /regular file/u
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('keeps the checked-in operator template deliberately non-passing', () => {
    const template = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../docs/ingress-boundary.template.json'),
        'utf8'
      )
    );
    assert.throws(
      () => verifyIngressBoundaryEvidence(template, { now: NOW }),
      /commit is invalid/u
    );
  });

  it('keeps input paths out of CLI failures and emits one safe success record', () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-ingress-cli-'));
    try {
      const secretPath = join(directory, 'customer-secret-name.json');
      writeFileSync(secretPath, '{}');
      const failed = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, 'verify-ingress-boundary.mjs'),
          secretPath,
          COMMIT,
        ],
        { encoding: 'utf8' }
      );
      assert.notEqual(failed.status, 0);
      assert.doesNotMatch(failed.stderr, /customer-secret-name/u);
      assert.doesNotMatch(
        failed.stdout,
        /BYOK_GRID_INGRESS_BOUNDARY_VERIFIED/u
      );

      const current = evidence();
      const recentTimestamp = new Date().toISOString();
      current.proxyBoundary.verifiedAt = recentTimestamp;
      for (const probe of current.clientProbes) {
        probe.verifiedAt = recentTimestamp;
        probe.checks.applicationRateLimit.observedAt = recentTimestamp;
        probe.checks.edgeRateLimit.observedAt = recentTimestamp;
      }
      writeFileSync(secretPath, JSON.stringify(current));
      const passed = spawnSync(
        process.execPath,
        [
          resolve(import.meta.dirname, 'verify-ingress-boundary.mjs'),
          secretPath,
          COMMIT,
        ],
        { encoding: 'utf8' }
      );
      assert.equal(passed.status, 0, passed.stderr);
      assert.equal(
        JSON.parse(passed.stdout).marker,
        INGRESS_BOUNDARY_EVIDENCE_MARKER
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});

function evidence() {
  return {
    candidateCommit: COMMIT,
    clientProbes: [clientProbe('c'.repeat(64)), clientProbe('d'.repeat(64))],
    origin: 'https://grid.example.test',
    proxyBoundary: {
      artifactSha256: DIGEST,
      directAccessDenied: true,
      forwardedForMode: 'overwrite',
      observedChainSha256: 'e'.repeat(64),
      reference: 'https://evidence.example.test/proxy-boundary',
      trustedProxyCidrsSha256: 'f'.repeat(64),
      verifiedAt: '2026-08-04T20:00:00.000Z',
    },
    schemaVersion: 1,
  };
}

function clientProbe(networkIdSha256) {
  return {
    candidateCommit: COMMIT,
    challengeSha256: '9'.repeat(64),
    checks: {
      applicationRateLimit: {
        acceptedResponses: 3,
        attempts: 4,
        limitedStatus: 429,
        observedAt: '2026-08-04T20:15:00.000Z',
        retryAfterSeconds: 10,
      },
      edgeRateLimit: {
        acceptedResponses: 9,
        attempts: 10,
        limitedStatus: 429,
        observedAt: '2026-08-04T20:15:00.000Z',
        retryAfterSeconds: 30,
      },
      publicDeployment: {
        marker: 'BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED',
        requests: 4,
      },
    },
    marker: 'BYOK_GRID_INGRESS_CLIENT_PROBE_VERIFIED',
    networkIdSha256,
    origin: 'https://grid.example.test',
    verifiedAt: '2026-08-04T20:15:00.000Z',
  };
}
