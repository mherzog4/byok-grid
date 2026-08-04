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
import { afterEach, beforeEach, describe, it } from 'node:test';
import {
  SMTP_DELIVERY_EVIDENCE_MARKER,
  verifySmtpDeliveryEvidence,
} from './verify-smtp-delivery-lib.mjs';

const CANDIDATE_COMMIT = 'a'.repeat(40);
const NOW = new Date('2026-08-04T15:00:00.000Z');
let directory;
let recoveryPath;
let verificationPath;

describe('SMTP delivery evidence verifier', () => {
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'byok-grid-smtp-evidence-'));
    verificationPath = join(directory, 'verification.eml');
    recoveryPath = join(directory, 'recovery.eml');
    writeFileSync(
      verificationPath,
      message({
        date: 'Tue, 04 Aug 2026 14:30:00 +0000',
        id: 'verification-1',
        subject: 'Verify your BYOK Grid email',
      })
    );
    writeFileSync(
      recoveryPath,
      message({
        date: 'Tue, 04 Aug 2026 14:35:00 +0000',
        id: 'recovery-1',
        subject: 'Reset your BYOK Grid password',
      })
    );
  });

  afterEach(() => rmSync(directory, { force: true, recursive: true }));

  it('binds two controlled-inbox deliveries to passing authentication and live DNS', async () => {
    const evidence = await verifySmtpDeliveryEvidence(options());
    assert.equal(evidence.marker, SMTP_DELIVERY_EVIDENCE_MARKER);
    assert.equal(evidence.candidateCommit, CANDIDATE_COMMIT);
    assert.equal(evidence.senderDomain, 'example.com');
    assert.equal(evidence.messages.length, 2);
    assert.deepEqual(
      evidence.messages.map(({ kind }) => kind),
      ['verification', 'password-reset']
    );
    assert.equal(evidence.dnsRecords.length, 3);
    assert.deepEqual(evidence.checks, {
      authenticationResults: true,
      controlledInboxDelivery: true,
      dkim: true,
      dmarc: true,
      spf: true,
    });
    assert.match(evidence.recipientSha256, /^[0-9a-f]{64}$/u);
    assert.equal(evidence.verifiedAt, NOW.toISOString());
    assert.doesNotMatch(JSON.stringify(evidence), /controlled@example\.net/u);
  });

  it('rejects failed results, sender misalignment, and duplicate trusted headers', async () => {
    for (const replacement of [
      ['spf=pass', 'spf=fail'],
      ['header.d=example.com', 'header.d=attacker.example'],
      [
        'Authentication-Results: mx.controlled.example;',
        'Authentication-Results: mx.controlled.example;\r\n' +
          ' spf=pass smtp.mailfrom=bounce.example.com;\r\n' +
          ' dkim=pass header.d=example.com header.s=release;\r\n' +
          ' dmarc=pass header.from=example.com\r\n' +
          'Authentication-Results: mx.controlled.example;',
      ],
    ]) {
      writeFileSync(
        verificationPath,
        message({
          date: 'Tue, 04 Aug 2026 14:30:00 +0000',
          id: 'verification-1',
          subject: 'Verify your BYOK Grid email',
        }).replace(replacement[0], replacement[1])
      );
      await assert.rejects(verifySmtpDeliveryEvidence(options()));
    }
  });

  it('requires the application automation header and matching DKIM signature', async () => {
    for (const replacement of [
      ['Auto-Submitted: auto-generated', 'Auto-Submitted: no'],
      ['d=example.com', 'd=other.example'],
      ['a=rsa-sha256', 'a=rsa-sha1'],
      ['b=c2lnbmF0dXJl', 'b='],
    ]) {
      writeFileSync(
        verificationPath,
        message({
          date: 'Tue, 04 Aug 2026 14:30:00 +0000',
          id: 'verification-1',
          subject: 'Verify your BYOK Grid email',
        }).replace(replacement[0], replacement[1])
      );
      await assert.rejects(verifySmtpDeliveryEvidence(options()));
    }
  });

  it('rejects different inboxes, repeated messages, and stale delivery', async () => {
    writeFileSync(
      recoveryPath,
      message({
        date: 'Tue, 04 Aug 2026 14:35:00 +0000',
        id: 'recovery-1',
        recipient: 'other@example.net',
        subject: 'Reset your BYOK Grid password',
      })
    );
    await assert.rejects(verifySmtpDeliveryEvidence(options()), /same inbox/u);

    writeFileSync(recoveryPath, readFileSync(verificationPath));
    await assert.rejects(verifySmtpDeliveryEvidence(options()), /subject/u);

    writeFileSync(
      verificationPath,
      message({
        date: 'Sun, 02 Aug 2026 14:30:00 +0000',
        id: 'verification-1',
        subject: 'Verify your BYOK Grid email',
      })
    );
    await assert.rejects(
      verifySmtpDeliveryEvidence(options()),
      /24-hour evidence window/u
    );
  });

  it('requires enforcing DMARC, a live DKIM key, and bounded SPF policy', async () => {
    const weakRecords = [
      ['_dmarc.example.com', [['v=DMARC1; p=none']]],
      ['release._domainkey.example.com', [['v=DKIM1; p=']]],
      ['bounce.example.com', [['v=spf1 include:_spf.example.net ?all']]],
    ];
    for (const [name, answer] of weakRecords) {
      const base = dnsRecords();
      base.set(name, answer);
      await assert.rejects(
        verifySmtpDeliveryEvidence(options({ resolveTxt: resolver(base) }))
      );
    }
  });

  it('rejects unreadable, symlinked, and oversized message inputs without echoing paths', async () => {
    const link = join(directory, 'message-link.eml');
    symlinkSync(verificationPath, link);
    await assert.rejects(
      verifySmtpDeliveryEvidence(options({ verificationMessagePath: link })),
      (error) => {
        assert.doesNotMatch(String(error), /message-link/u);
        return true;
      }
    );

    const secretPath = join(directory, 'private-recipient-token.eml');
    await assert.rejects(
      verifySmtpDeliveryEvidence(
        options({ verificationMessagePath: secretPath })
      ),
      (error) => {
        assert.doesNotMatch(String(error), /private-recipient-token/u);
        return true;
      }
    );

    writeFileSync(verificationPath, Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    await assert.rejects(
      verifySmtpDeliveryEvidence(options()),
      /between 1 byte and 2 MiB/u
    );
  });

  it('keeps received-message paths out of CLI diagnostics', () => {
    const secretVerificationPath = join(
      directory,
      'private-verification-recipient.eml'
    );
    const secretRecoveryPath = join(directory, 'private-reset-token.eml');
    const result = spawnSync(
      process.execPath,
      [
        join(import.meta.dirname, 'verify-smtp-delivery.mjs'),
        CANDIDATE_COMMIT,
        'example.com',
        'mx.controlled.example',
        secretVerificationPath,
        secretRecoveryPath,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /could not be read/u);
    assert.doesNotMatch(
      result.stderr,
      /private-verification-recipient|private-reset-token/u
    );
  });

  it('keeps the verifier dependency-free', () => {
    for (const file of [
      'verify-smtp-delivery-lib.mjs',
      'verify-smtp-delivery.mjs',
    ]) {
      const source = readFileSync(join(import.meta.dirname, file), 'utf8');
      assert.doesNotMatch(source, /from ['"](?!node:|\.\/)/u);
    }
  });
});

function options(overrides = {}) {
  return {
    authenticationService: 'mx.controlled.example',
    candidateCommit: CANDIDATE_COMMIT,
    now: () => NOW,
    recoveryMessagePath: recoveryPath,
    resolveTxt: resolver(dnsRecords()),
    senderDomain: 'example.com',
    verificationMessagePath: verificationPath,
    ...overrides,
  };
}

function message({ date, id, recipient = 'controlled@example.net', subject }) {
  return [
    'From: BYOK Grid Security <security@example.com>',
    `To: Controlled Inbox <${recipient}>`,
    `Subject: ${subject}`,
    `Date: ${date}`,
    `Message-ID: <${id}@mailer.example.com>`,
    'Auto-Submitted: auto-generated',
    'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=release;',
    ' bh=Ym9keWhhc2g=; b=c2lnbmF0dXJl',
    'Authentication-Results: mx.controlled.example;',
    ' spf=pass smtp.mailfrom=bounce.example.com;',
    ' dkim=pass header.d=example.com header.s=release;',
    ' dmarc=pass header.from=example.com',
    '',
    'Authentication link intentionally treated as private.',
    '',
  ].join('\r\n');
}

function dnsRecords() {
  return new Map([
    [
      'bounce.example.com',
      [['v=spf1 include:_spf.transactional.example -all']],
    ],
    ['release._domainkey.example.com', [['v=DKIM1; k=rsa; p=QUJDREVGRw==']]],
    ['_dmarc.example.com', [['v=DMARC1; p=reject; pct=100']]],
  ]);
}

function resolver(records) {
  return async (name) => {
    if (!records.has(name)) throw new Error('NXDOMAIN secret provider detail');
    return records.get(name);
  };
}
