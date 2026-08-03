# ADR 0040: Provider-neutral authentication email

- Status: accepted
- Date: 2026-08-03
- Supersedes: none
- Extends: ADR 0003, ADR 0038, and ADR 0039

## Context

Controlled account provisioning and bounded sessions made a public release fail
closed, but an account owner still had no reviewed forgotten-password path.
Enabling verified email or reset links through a proprietary API would impose a
vendor choice on every open-source operator. Implementing custom token storage
would duplicate Better Auth's single-use verification lifecycle.

Authentication links are bearer credentials. Their delivery creates new URL,
transport, log, caching, enumeration, abuse, and deployment-secret boundaries.

## Decision

Authentication email has two modes:

- `disabled`, the default, constructs no transport and exposes no recovery UI;
- `smtp`, which uses operator-supplied generic SMTP configuration and enables
  verified-email enforcement plus password reset.

SMTP mode requires a validated host and sender. Username and password are an
optional pair. Non-loopback delivery must use implicit TLS or require STARTTLS;
certificate verification, TLS 1.2 minimum, bounded timeouts, limited pooling,
disabled debug logging, header-safe sender fields, and file/URL access denial
are fixed application controls. Generated auth links must match the canonical
application origin and `/api/auth/*` path before delivery.

Better Auth owns token generation and persistence. Verification and reset links
expire after one hour. SMTP-enabled signup requires verification and creates no
session until inbox control is proven; a correct unverified sign-in triggers
another verification message. Reset requests keep the same public response for
known and unknown addresses, including when SMTP delivery fails; the server
records only a recipient-free email-kind diagnostic. Reset and verification
requests receive a 500-millisecond minimum response time across success,
unknown-account, validation, and outage paths. Reset tokens are single-use, and
successful reset revokes every session.

Recovery pages render only in SMTP mode. Reset pages are private, no-store,
non-indexable, and no-referrer. Compose and Helm expose the same policy; Helm
keeps credentials in the Secret contract and rejects plaintext SMTP. Public
open signup remains prohibited independently of email availability.

## Consequences

- Self-hosters can use any standards-compatible SMTP provider without changing
  application code.
- A deployment may remain intentionally email-free, but then it has no product
  password-recovery path and must keep recovery UI absent.
- Existing unverified users can receive verification after a correct password
  attempt when an operator later enables SMTP.
- A password reset contains a stolen session as well as replacing a password.
- SMTP availability affects email operations but is not part of web liveness;
  structural configuration is checked at readiness, while actual delivery is a
  deployment preflight and monitoring responsibility.
- Invitation delivery remains manual; this adapter sends only authentication
  email in the current release.
- Bounce and complaint ingestion, templates/localization, DKIM signing inside
  the application, and unrestricted public signup remain future work.

## Verification

Policy tests cover disabled defaults, TLS requirements, loopback evaluation,
paired credentials, ports, modes, and secret-safe failures. Transport tests
freeze timeouts, pooling, TLS, canonical-link enforcement, and message safety.
SQLite integration tests prove verification, unknown-address behavior,
delivery-outage enumeration resistance, single-use reset, session revocation,
and password replacement. The compiled standalone drill receives real SMTP
MIME messages and follows their links through the production Next.js server.
Helm renders disabled and TLS-enabled SMTP modes and rejects missing-host and
plaintext configurations.
