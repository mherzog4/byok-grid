import { createHash } from 'node:crypto';
import { resolveTxt } from 'node:dns/promises';
import { lstatSync, readFileSync } from 'node:fs';

export const SMTP_DELIVERY_EVIDENCE_MARKER =
  'BYOK_GRID_SMTP_DELIVERY_AUTHENTICATION_VERIFIED';

const COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const DOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const MAXIMUM_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAXIMUM_HEADER_BYTES = 128 * 1024;
const MAXIMUM_MESSAGE_AGE_MS = 24 * 60 * 60 * 1000;
const MAXIMUM_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class SmtpDeliveryEvidenceError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SmtpDeliveryEvidenceError';
  }
}

export async function verifySmtpDeliveryEvidence(options) {
  if (!COMMIT_PATTERN.test(options.candidateCommit ?? '')) {
    fail('The candidate commit must be a lowercase 40-character SHA.');
  }
  const senderDomain = canonicalDomain(options.senderDomain, 'sender domain');
  const authenticationService = canonicalDomain(
    options.authenticationService,
    'authentication service'
  );
  const now = dateOption(options.now?.() ?? new Date(), 'verification clock');
  const resolver = options.resolveTxt ?? resolveTxt;

  const verificationSource = readMessageFile(options.verificationMessagePath);
  const recoverySource = readMessageFile(options.recoveryMessagePath);
  const messages = [
    parseReceivedMessage({
      authenticationService,
      expectedSubject: 'Verify your BYOK Grid email',
      kind: 'verification',
      now,
      senderDomain,
      source: verificationSource,
    }),
    parseReceivedMessage({
      authenticationService,
      expectedSubject: 'Reset your BYOK Grid password',
      kind: 'password-reset',
      now,
      senderDomain,
      source: recoverySource,
    }),
  ];

  if (messages[0].recipient !== messages[1].recipient) {
    fail('Verification and recovery were not delivered to the same inbox.');
  }
  if (messages[0].messageIdSha256 === messages[1].messageIdSha256) {
    fail('Verification and recovery reused one Message-ID.');
  }
  if (messages[0].messageSha256 === messages[1].messageSha256) {
    fail('Verification and recovery message files are identical.');
  }

  const dnsRecords = await verifyAuthenticationDns({
    messages,
    resolver,
    senderDomain,
  });

  return {
    authenticationServiceSha256: sha256(authenticationService),
    candidateCommit: options.candidateCommit,
    checks: {
      authenticationResults: true,
      controlledInboxDelivery: true,
      dkim: true,
      dmarc: true,
      spf: true,
    },
    dnsRecords,
    marker: SMTP_DELIVERY_EVIDENCE_MARKER,
    messages: messages.map((message) => ({
      kind: message.kind,
      messageDate: message.messageDate,
      messageIdSha256: message.messageIdSha256,
      messageSha256: message.messageSha256,
    })),
    recipientSha256: sha256(messages[0].recipient),
    senderDomain,
    verifiedAt: now.toISOString(),
  };
}

function readMessageFile(path) {
  if (typeof path !== 'string' || path.length === 0) {
    fail('Both received-message paths are required.');
  }
  try {
    const metadata = lstatSync(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size === 0 ||
      metadata.size > MAXIMUM_MESSAGE_BYTES
    ) {
      fail(
        'A received message must be a regular file between 1 byte and 2 MiB.'
      );
    }
    return readFileSync(path);
  } catch (error) {
    if (error instanceof SmtpDeliveryEvidenceError) throw error;
    throw new SmtpDeliveryEvidenceError(
      'A received message could not be read.',
      { cause: error }
    );
  }
}

function parseReceivedMessage(input) {
  const sourceText = input.source.toString('utf8');
  if (sourceText.includes('\u0000') || sourceText.includes('\uFFFD')) {
    fail('A received message has an invalid header encoding.');
  }
  const separator = /\r?\n\r?\n/u.exec(sourceText);
  if (!separator || separator.index > MAXIMUM_HEADER_BYTES) {
    fail('A received message has no bounded RFC 5322 header block.');
  }
  const headers = parseHeaders(sourceText.slice(0, separator.index));
  const subject = singleHeader(headers, 'subject');
  if (subject !== input.expectedSubject) {
    fail('A received message has the wrong BYOK Grid authentication subject.');
  }
  if (
    singleHeader(headers, 'auto-submitted').toLocaleLowerCase('en-US') !==
    'auto-generated'
  ) {
    fail('A received message has the wrong Auto-Submitted policy.');
  }

  const fromDomain = addressDomain(singleHeader(headers, 'from'), 'From');
  if (fromDomain !== input.senderDomain) {
    fail('A received message From domain does not match the declared sender.');
  }
  const recipient = canonicalAddress(singleHeader(headers, 'to'), 'To');
  const messageId = singleHeader(headers, 'message-id');
  if (messageId.length > 998 || !/^<[^<>\s@]+@[^<>\s@]+>$/u.test(messageId)) {
    fail('A received message has an invalid Message-ID.');
  }

  const messageDate = new Date(singleHeader(headers, 'date'));
  if (!Number.isFinite(messageDate.getTime())) {
    fail('A received message has an invalid Date header.');
  }
  const age = input.now.getTime() - messageDate.getTime();
  if (age < -MAXIMUM_CLOCK_SKEW_MS || age > MAXIMUM_MESSAGE_AGE_MS) {
    fail('A received message is outside the 24-hour evidence window.');
  }

  const authenticationHeaders = headers.get('authentication-results') ?? [];
  const matchingAuthenticationHeaders = authenticationHeaders.filter((value) =>
    value
      .toLocaleLowerCase('en-US')
      .startsWith(`${input.authenticationService};`)
  );
  if (matchingAuthenticationHeaders.length !== 1) {
    fail(
      'A received message must have exactly one trusted Authentication-Results header.'
    );
  }
  const authentication = parseAuthenticationResults(
    matchingAuthenticationHeaders[0]
  );
  verifyMatchingDkimSignature(headers, authentication);
  if (authentication.dmarcFromDomain !== fromDomain) {
    fail('DMARC authenticated a different From domain.');
  }
  if (!domainWithin(authentication.dkimDomain, input.senderDomain)) {
    fail('DKIM is not aligned with the declared sender domain.');
  }
  if (!domainWithin(authentication.spfMailFromDomain, input.senderDomain)) {
    fail('SPF is not aligned with the declared sender domain.');
  }

  return {
    ...authentication,
    kind: input.kind,
    messageDate: messageDate.toISOString(),
    messageIdSha256: sha256(messageId),
    messageSha256: sha256(input.source),
    recipient,
  };
}

function parseHeaders(source) {
  const unfolded = [];
  for (const line of source.split(/\r?\n/u)) {
    if (/^[ \t]/u.test(line)) {
      if (unfolded.length === 0) {
        fail('A received message starts with an invalid folded header.');
      }
      unfolded[unfolded.length - 1] += ` ${line.trim()}`;
      continue;
    }
    unfolded.push(line);
  }

  const headers = new Map();
  for (const line of unfolded) {
    if (line.length > 998) {
      fail('A received message contains an oversized unfolded header.');
    }
    const separator = line.indexOf(':');
    const name = line.slice(0, separator).toLocaleLowerCase('en-US');
    if (separator < 1 || !/^[a-z0-9-]+$/u.test(name)) {
      fail('A received message contains a malformed header.');
    }
    const values = headers.get(name) ?? [];
    values.push(line.slice(separator + 1).trim());
    headers.set(name, values);
  }
  return headers;
}

function singleHeader(headers, name) {
  const values = headers.get(name) ?? [];
  if (values.length !== 1 || values[0].length === 0) {
    fail(`A received message must contain exactly one ${name} header.`);
  }
  return values[0];
}

function canonicalAddress(value, name) {
  const matches = [
    ...value.matchAll(
      /(?:<)?([a-z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-z0-9.-]+)(?:>)?/giu
    ),
  ];
  if (matches.length !== 1) {
    fail(`The ${name} header must contain exactly one email address.`);
  }
  const domain = canonicalDomain(matches[0][2], `${name} domain`);
  return `${matches[0][1].toLocaleLowerCase('en-US')}@${domain}`;
}

function addressDomain(value, name) {
  return canonicalAddress(value, name).split('@').at(-1);
}

function parseAuthenticationResults(value) {
  const segments = value
    .split(';')
    .slice(1)
    .map((segment) => segment.trim());
  const spf = authenticationSegment(segments, 'spf');
  const dkim = authenticationSegment(segments, 'dkim');
  const dmarc = authenticationSegment(segments, 'dmarc');
  return {
    dkimDomain: canonicalDomain(
      authenticationProperty(dkim, 'header.d'),
      'DKIM domain'
    ),
    dkimSelector: canonicalSelector(authenticationProperty(dkim, 'header.s')),
    dmarcFromDomain: canonicalDomain(
      authenticationProperty(dmarc, 'header.from'),
      'DMARC From domain'
    ),
    spfMailFromDomain: addressOrDomain(
      authenticationProperty(spf, 'smtp.mailfrom'),
      'SPF envelope domain'
    ),
  };
}

function verifyMatchingDkimSignature(headers, authentication) {
  const signatures = headers.get('dkim-signature') ?? [];
  const matching = signatures.filter((signature) => {
    const tags = signatureTags(signature);
    return (
      tags.get('d') === authentication.dkimDomain &&
      tags.get('s') === authentication.dkimSelector &&
      ['ed25519-sha256', 'rsa-sha256'].includes(
        tags.get('a')?.toLocaleLowerCase('en-US')
      ) &&
      validBase64Tag(tags.get('b')) &&
      validBase64Tag(tags.get('bh'))
    );
  });
  if (matching.length !== 1) {
    fail(
      'A received message must contain one passing DKIM signature matching Authentication-Results.'
    );
  }
}

function authenticationSegment(segments, method) {
  const matches = segments.filter((segment) =>
    new RegExp(`^${method}\\s*=`, 'iu').test(segment)
  );
  if (matches.length !== 1) {
    fail(`Authentication-Results must contain exactly one ${method} result.`);
  }
  if (!new RegExp(`^${method}\\s*=\\s*pass(?:\\s|$)`, 'iu').test(matches[0])) {
    fail(`Authentication-Results reports that ${method} did not pass.`);
  }
  return matches[0];
}

function authenticationProperty(segment, property) {
  const escapedProperty = property.replace('.', '\\.');
  const match = new RegExp(
    `(?:^|\\s)${escapedProperty}\\s*=\\s*(?:"([^"]+)"|([^\\s();]+))`,
    'iu'
  ).exec(segment);
  const value = match?.[1] ?? match?.[2];
  if (!value) {
    fail(`Authentication-Results is missing ${property}.`);
  }
  return value.replace(/^<|>$/gu, '');
}

function addressOrDomain(value, name) {
  const at = value.lastIndexOf('@');
  return canonicalDomain(at === -1 ? value : value.slice(at + 1), name);
}

async function verifyAuthenticationDns(input) {
  const lookups = new Map();
  for (const message of input.messages) {
    lookups.set(`spf:${message.spfMailFromDomain}`, {
      kind: 'spf',
      name: message.spfMailFromDomain,
    });
    const dkimName = `${message.dkimSelector}._domainkey.${message.dkimDomain}`;
    lookups.set(`dkim:${dkimName}`, { kind: 'dkim', name: dkimName });
  }
  const dmarcName = `_dmarc.${input.senderDomain}`;
  lookups.set(`dmarc:${dmarcName}`, { kind: 'dmarc', name: dmarcName });

  const verified = [];
  for (const lookup of [...lookups.values()].sort(compareDnsLookup)) {
    let answer;
    try {
      answer = await input.resolver(lookup.name);
    } catch (error) {
      throw new SmtpDeliveryEvidenceError(
        `The ${lookup.kind.toUpperCase()} TXT record could not be resolved.`,
        { cause: error }
      );
    }
    const records = txtRecords(answer);
    const record = authenticatedDnsRecord(records, lookup.kind);
    verified.push({
      kind: lookup.kind,
      name: lookup.name,
      sha256: sha256(record),
    });
  }
  return verified;
}

function txtRecords(answer) {
  if (
    !Array.isArray(answer) ||
    answer.some(
      (chunks) =>
        !Array.isArray(chunks) ||
        chunks.some((chunk) => typeof chunk !== 'string')
    )
  ) {
    fail('A DNS TXT lookup returned an invalid response shape.');
  }
  return answer.map((chunks) => chunks.join('').trim());
}

function authenticatedDnsRecord(records, kind) {
  const prefix = { dkim: 'v=dkim1', dmarc: 'v=dmarc1', spf: 'v=spf1' }[kind];
  const matches = records.filter((record) =>
    record.toLocaleLowerCase('en-US').startsWith(prefix)
  );
  if (matches.length !== 1) {
    fail(`DNS must publish exactly one ${kind.toUpperCase()} TXT record.`);
  }
  const record = matches[0];
  if (record.length > 2_048 || /[\r\n\u0000]/u.test(record)) {
    fail(`The ${kind.toUpperCase()} TXT record is invalid.`);
  }
  if (kind === 'spf') verifySpfRecord(record);
  if (kind === 'dkim') verifyDkimRecord(record);
  if (kind === 'dmarc') verifyDmarcRecord(record);
  return record;
}

function verifySpfRecord(record) {
  if (!/(?:^|\s)[~-]all\s*$/iu.test(record)) {
    fail('The SPF policy must end in soft-fail or fail for unmatched senders.');
  }
}

function verifyDkimRecord(record) {
  const tags = dnsTags(record);
  if (tags.get('v')?.toLocaleLowerCase('en-US') !== 'dkim1') {
    fail('The DKIM TXT record has the wrong version.');
  }
  const publicKey = tags.get('p') ?? '';
  if (!publicKey || !/^[a-z0-9+/=]+$/iu.test(publicKey)) {
    fail('The DKIM TXT record has no valid public key.');
  }
  const keyType = tags.get('k')?.toLocaleLowerCase('en-US') ?? 'rsa';
  if (!['ed25519', 'rsa'].includes(keyType)) {
    fail('The DKIM TXT record uses an unsupported key type.');
  }
}

function verifyDmarcRecord(record) {
  const tags = dnsTags(record);
  if (tags.get('v')?.toLocaleLowerCase('en-US') !== 'dmarc1') {
    fail('The DMARC TXT record has the wrong version.');
  }
  const policy = tags.get('p')?.toLocaleLowerCase('en-US');
  if (!['quarantine', 'reject'].includes(policy)) {
    fail('The DMARC policy must enforce quarantine or reject.');
  }
  if (tags.has('pct') && tags.get('pct') !== '100') {
    fail('The DMARC enforcement percentage must be 100.');
  }
}

function dnsTags(record) {
  const tags = new Map();
  for (const rawTag of record.split(';')) {
    const separator = rawTag.indexOf('=');
    if (separator < 1) continue;
    const name = rawTag.slice(0, separator).trim().toLocaleLowerCase('en-US');
    const value = rawTag.slice(separator + 1).trim();
    if (tags.has(name)) fail('A DNS authentication record repeats a tag.');
    tags.set(name, value);
  }
  return tags;
}

function signatureTags(value) {
  const tags = new Map();
  for (const rawTag of value.split(';')) {
    const separator = rawTag.indexOf('=');
    if (separator < 1) continue;
    const name = rawTag.slice(0, separator).trim().toLocaleLowerCase('en-US');
    const tagValue = rawTag.slice(separator + 1).trim();
    if (tags.has(name)) fail('A DKIM signature repeats a tag.');
    tags.set(name, tagValue);
  }
  return tags;
}

function validBase64Tag(value) {
  const compact = value?.replace(/\s/gu, '') ?? '';
  return compact.length > 0 && /^[a-z0-9+/=]+$/iu.test(compact);
}

function canonicalDomain(value, name) {
  if (typeof value !== 'string' || value !== value.toLocaleLowerCase('en-US')) {
    fail(`The ${name} must be a canonical lowercase domain.`);
  }
  if (
    value.length > 253 ||
    value.includes('..') ||
    value.endsWith('.') ||
    value.split('.').length < 2 ||
    !value.split('.').every((label) => DOMAIN_LABEL_PATTERN.test(label))
  ) {
    fail(`The ${name} must be a canonical lowercase domain.`);
  }
  return value;
}

function canonicalSelector(value) {
  if (
    typeof value !== 'string' ||
    value !== value.toLocaleLowerCase('en-US') ||
    !DOMAIN_LABEL_PATTERN.test(value)
  ) {
    fail('The DKIM selector must be one canonical DNS label.');
  }
  return value;
}

function domainWithin(value, parent) {
  return value === parent || value.endsWith(`.${parent}`);
}

function dateOption(value, name) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail(`The ${name} is invalid.`);
  }
  return value;
}

function compareDnsLookup(left, right) {
  return `${left.kind}:${left.name}`.localeCompare(
    `${right.kind}:${right.name}`
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function fail(message) {
  throw new SmtpDeliveryEvidenceError(message);
}
