# ADR 0038: Fail closed for public account provisioning

- Status: accepted
- Date: 2026-08-03
- Supersedes: none
- Extends: ADR 0003 and ADR 0035

## Context

BYOK Grid supports self-hosted email/password identity, but it does not yet own
a transactional-email implementation. Enabling unrestricted public signup
without verified-email delivery exposes an account-squatting boundary and
conflicts with ADR 0003's production constraint.

Operators still need a safe way to bootstrap owners and provision a bounded set
of collaborators. A temporary global signup window would expose every address
during that window and is easy to forget after provisioning.

## Decision

Account provisioning has three runtime modes:

- `disabled` rejects every new email/password account;
- `allowlist` permits only normalized addresses supplied through
  `BYOK_GRID_SIGNUP_ALLOWED_EMAILS`; and
- `open` permits registration only when `BETTER_AUTH_URL` targets loopback.

When no mode is configured, loopback defaults to `open` and every other origin
defaults to `disabled`. Explicit public `open`, unknown modes, malformed
allowlist entries, and an empty allowlist mode fail runtime validation. Error
messages identify entry positions without logging configured addresses.

Better Auth's native `disableSignUp` option implements disabled mode. A
user-creation `before` hook enforces allowlist mode before auth rows or personal
workspace data are written. The server-rendered sign-in page hides disabled
registration and labels allowlisted registration, but UI state is not an
authorization boundary.

The Kubernetes chart exposes only `disabled` and `allowlist`. It stores the mode
in ordinary configuration and reads addresses from an optional Secret key. The
Compose evaluation profile explicitly selects loopback `open` mode.

## Consequences

- A public deployment that omits signup configuration cannot accept accounts.
- Operators can provision known addresses without exposing a global signup
  window.
- Allowlisted addresses must be removed after use and remain sensitive
  operational configuration.
- Case-insensitive comparison matches Better Auth's normalized email identity.
- Allowlisting does not prove inbox ownership and does not provide password
  reset delivery.
- Unrestricted public signup remains unavailable until verified-email delivery
  is designed, implemented, and exercised.

## Verification

Pure policy tests cover defaults, normalization, invalid modes, malformed
entries, and secret-safe errors. File-backed SQLite integration tests invoke
Better Auth's server API and verify rejected writes, approved session creation,
and personal-workspace provisioning. A standalone drill starts separate compiled
servers for rejected public-open, disabled, and allowlist modes and verifies
their startup, HTTP, and rendered-UI contracts. Helm tests require a disabled
default, secret reference, allowlist render, and schema rejection of public
`open` mode.
