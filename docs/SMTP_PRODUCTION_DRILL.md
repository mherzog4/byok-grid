# Verify production SMTP delivery and sender authentication

This drill turns two real controlled-inbox deliveries into a bounded,
credential-free release record. It analyzes one verification email and one
password-reset email produced by the exact release candidate, requires the
trusted receiving service to report SPF, DKIM, and DMARC pass results, and
checks the corresponding DNS records live.

The raw messages contain account addresses and single-use authentication links.
Keep them in restricted operator storage. Never commit them, attach them to a
public issue, or paste their headers or bodies into CI logs.

## Prepare the isolated account

Use a controlled mailbox that exposes the original RFC 5322 message source.
Deploy the digest-pinned candidate with authenticated TLS SMTP and allowlist
only that mailbox for signup. Run `npm run email:verify` inside the deployed web
environment first; retain its `BYOK_GRID_SMTP_CONNECTION_VERIFIED` marker.

Then complete both application paths through the canonical HTTPS origin:

1. create the allowlisted account and receive the email-verification message;
2. use the verification link and confirm the account can sign in;
3. request password recovery and receive the reset message; and
4. use the reset link, confirm the old password fails, the new password works,
   and existing sessions were revoked.

Export the original source for both received messages as separate `.eml` files.
Identify the receiving service's trusted `authserv-id`: it is the first token
in the `Authentication-Results` header added by the controlled mailbox. Use the
receiver's documented value, not a header copied from an untrusted sender.

## Run the verifier

Run from a trusted operator host with current DNS access. Paths are positional
only because they identify restricted local files; the command never includes
them in success output or failure diagnostics.

```text
npm run release:verify-smtp-delivery -- \
  <40-character-candidate-commit> \
  <lowercase-sender-domain> \
  <trusted-authserv-id> \
  /restricted/path/verification.eml \
  /restricted/path/password-reset.eml
```

Each message must be a regular, non-symlink file no larger than two MiB. The
verifier requires:

- the exact BYOK Grid verification and password-reset subjects;
- the application `Auto-Submitted: auto-generated` policy and a DKIM signature
  matching the receiver's passing domain and selector;
- the exact declared `From` domain and one identical controlled recipient;
- distinct valid Message-IDs and distinct raw-message digests;
- message dates within the preceding 24 hours;
- exactly one `Authentication-Results` header from the named trusted receiver;
- `spf=pass`, `dkim=pass`, and `dmarc=pass` with the expected result properties;
- SPF envelope and DKIM signing domains aligned beneath the declared sender;
- one live SPF record for every observed envelope domain, ending in `~all` or
  `-all`;
- one live non-revoked RSA or Ed25519 DKIM key for every observed selector; and
- one live DMARC record at the sender domain with `p=quarantine` or `p=reject`
  and full enforcement.

Success emits one JSON line with marker
`BYOK_GRID_SMTP_DELIVERY_AUTHENTICATION_VERIFIED`. It includes the candidate
commit, sender domain, verification time, raw-message and Message-ID hashes,
recipient and authentication-service hashes, and hashes of the observed DNS
records. It does not emit addresses, message bodies, authentication links,
Message-IDs, provider errors, or raw DNS values.

Retain the success record with the two restricted raw messages, deployed image
digests, SMTP connection marker, canonical-origin account-flow evidence,
provider identity, operator, and UTC start/end time. Hash the complete retained
bundle for the stable production evidence manifest.

## Provider monitoring remains a separate gate

This command proves two recent deliveries and point-in-time sender
authentication. It does not prove inbox reputation, ongoing TLS behavior,
provider availability, or failure monitoring. Retain provider evidence that
the operator receives and triages deferrals, rejections, bounces, complaints,
and SMTP authentication failures. The `smtp-delivery` production evidence
record must contain both this command's marker and that provider monitoring
record.

After accepting the evidence, remove the allowlisted address, clean up the
isolated account, revoke test sessions, delete local raw-message copies under
the operator's retention procedure, and restore the intended provisioning
policy.
