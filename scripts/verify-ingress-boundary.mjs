import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyIngressBoundaryEvidenceFile } from './verify-ingress-boundary-lib.mjs';

function main() {
  try {
    if (process.argv.length !== 4) {
      throw new Error(
        'Provide the ingress evidence file and expected candidate commit.'
      );
    }
    process.stdout.write(
      `${JSON.stringify(
        verifyIngressBoundaryEvidenceFile(process.argv[2], {
          expectedCandidateCommit: process.argv[3],
        })
      )}\n`
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Ingress evidence verification failed.'}\n`
    );
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main();
}
