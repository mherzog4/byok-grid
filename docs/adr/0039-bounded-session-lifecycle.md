# ADR 0039: Bound and expose the session lifecycle

- Status: accepted
- Date: 2026-08-03
- Supersedes: none
- Extends: ADR 0003, ADR 0035, and ADR 0038

## Context

Database-backed email/password sessions already existed, but their expiry and
refresh behavior were inherited implicitly from Better Auth. Users could sign
out the current browser but had no product control for containing another
active login. An implicit dependency default is not an adequate security or
operational contract for a self-hosted release.

Better Auth's session-listing API includes raw session tokens. Rendering that
result directly in a client component would create a new credential-exposure
surface even if the UI displayed only device counts.

## Decision

BYOK Grid resolves a deployment-owned session policy at startup:

- expiry defaults to seven days and is configurable from 15 minutes through 30
  days;
- public origins default to a hard expiry with refresh disabled;
- loopback origins default to sliding refresh for local evaluation;
- refresh age defaults to one day, is configurable from one minute, and must be
  shorter than expiry; and
- malformed, excessive, or inconsistent values fail runtime validation.

The Better Auth cookie cache remains disabled so a database revocation applies
to the next request. The protected account page lists sessions only in server
code, compares their tokens with the current token there, and passes only an
integer count to the client. The user may revoke every other active session
without revoking the current one. Sign-out and revocation failures remain on
the page with an actionable error instead of navigating as though they
succeeded. The Next.js boundary returns `404` for external calls to the
raw-token-bearing Better Auth session-list endpoint; direct server API calls do
not traverse that HTTP route.

Compose selects sliding refresh only for its loopback evaluation profile. The
Helm chart defaults public releases to a hard seven-day session, validates the
bounded scalar values, and leaves the cross-field update-age rule to runtime
validation.

## Consequences

- A stolen public-deployment cookie has a bounded default lifetime even while
  it remains active.
- Users can contain suspected access from another browser without interrupting
  the browser they are using to respond.
- Raw tokens remain an authentication-library and server-only concern.
- Operators retain a documented security-versus-convenience choice without
  source changes, but cannot configure an unbounded lifetime.
- Immediate revocation requires a database lookup rather than accepting a
  cookie-cached session.
- Bounded sessions do not supply verified email, forgotten-password delivery,
  device labels, or administrator-driven user revocation.

## Verification

Pure policy tests cover public and loopback defaults, explicit configuration,
ambiguous booleans, excessive expiry, and cross-field consistency. Runtime
tests prove invalid values fail readiness. File-backed SQLite integration tests
create two sessions, check their expiry bounds, revoke the older one, and
preserve the current one. The compiled standalone drill repeats the behavior
through HTTP and additionally proves raw tokens are absent from rendered
account HTML and external session listing is unavailable. Helm tests freeze the
secure default, an explicit CI policy, and schema rejection above the maximum
lifetime.
