#!/usr/bin/env node
import { verifySmtpDeliveryEvidence } from './verify-smtp-delivery-lib.mjs';

const [
  candidateCommit,
  senderDomain,
  authenticationService,
  verificationPath,
  recoveryPath,
] = process.argv.slice(2);

try {
  if (
    process.argv.length !== 7 ||
    !candidateCommit ||
    !senderDomain ||
    !authenticationService ||
    !verificationPath ||
    !recoveryPath
  ) {
    throw new Error(
      'Usage: verify-smtp-delivery <candidate-commit> <sender-domain> <authentication-service> <verification.eml> <recovery.eml>'
    );
  }
  const result = await verifySmtpDeliveryEvidence({
    authenticationService,
    candidateCommit,
    recoveryMessagePath: recoveryPath,
    senderDomain,
    verificationMessagePath: verificationPath,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message =
    error instanceof Error ? error.message : 'Unknown verification failure.';
  process.stderr.write(`SMTP delivery verification failed: ${message}\n`);
  process.exitCode = 1;
}
