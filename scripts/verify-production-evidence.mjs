import process from 'node:process';
import {
  PRODUCTION_EVIDENCE_MARKER,
  ProductionEvidenceError,
  verifyProductionEvidenceFile,
} from './verify-production-evidence-lib.mjs';

const [path, expectedReleaseVersion, expectedCandidateCommit] =
  process.argv.slice(2);

if (!path || !expectedReleaseVersion || !expectedCandidateCommit) {
  process.stderr.write(
    'Production evidence verification failed: pass the manifest path, stable version, and observed candidate commit.\n'
  );
  process.exit(1);
}

try {
  const verified = verifyProductionEvidenceFile(path, {
    expectedCandidateCommit,
    expectedReleaseVersion,
  });
  process.stdout.write(
    `${JSON.stringify({
      evidenceCount: verified.evidenceCount,
      marker: PRODUCTION_EVIDENCE_MARKER,
      observationHours: verified.observationHours,
      candidateCommit: verified.candidateCommit,
      releaseVersion: verified.releaseVersion,
      supportedOptionalAdapters: verified.supportedOptionalAdapters,
    })}\n`
  );
} catch (error) {
  const message =
    error instanceof ProductionEvidenceError
      ? error.message
      : 'Production evidence verification failed unexpectedly.';
  process.stderr.write(`Production evidence verification failed: ${message}\n`);
  process.exit(1);
}
