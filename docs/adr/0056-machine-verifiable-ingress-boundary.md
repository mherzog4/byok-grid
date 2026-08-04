# ADR 0056: Machine-verifiable production ingress boundary

- Status: Accepted
- Date: 2026-08-04

## Context

The public deployment verifier proves TLS-visible health, security headers,
request correlation, and response-scoped CSP nonces. It does not prove that the
web origin rejects direct access, that the observed forwarded-address chain
matches the configured trusted proxies, or that both application and edge rate
limits operate from more than one client network. The stable evidence contract
previously assigned all of those claims to the public marker alone.

A generic `429` is also ambiguous. An edge response could conceal a disabled
application control, while an application response could be mistaken for a
configured distributed edge limit.

## Decision

BYOK Grid marks application-generated authentication `429` responses with
`X-BYOK-Grid-Rate-Limit-Layer: application`. Production edges must strip the
corresponding inbound request header, preserve application response provenance,
and mark only their own `429` responses as `edge` with integer `Retry-After`.

Provide a bounded, explicitly confirmed client drill that:

- reruns the exact public deployment verifier;
- uses four non-provisioning invalid sign-in attempts to prove the pinned
  application policy and `X-Retry-After` contract;
- uses safe `GET /sign-in` requests under an operator-declared ceiling to prove
  the distinct edge limit;
- hashes rather than emits opaque network and shared-challenge identities; and
- produces no credentials, IP addresses, request bodies, cookies, or provider
  errors.

Provide a dependency-free aggregate verifier that requires exactly two distinct
client-network records for the same candidate, origin, and hashed shared
challenge. The application completion timestamps must be no more than five
seconds apart, safely inside the fixed ten-second limit window, so a shared
fallback bucket cannot satisfy both records. The manifest also binds a hashed
retained record of the real forwarding chain, configured proxy boundary, and
direct-origin denial. All observations must fall within one 24-hour window.

Stable `public-ingress-and-proxy` evidence requires both
`BYOK_GRID_PUBLIC_DEPLOYMENT_VERIFIED` and
`BYOK_GRID_INGRESS_BOUNDARY_VERIFIED`.

## Consequences

- Operators must configure an observable edge-generated `429` contract and run
  from two real networks; one local or hosted probe cannot satisfy the gate.
- Application and edge controls cannot impersonate one another using status
  alone.
- Raw topology evidence remains private while its digest and HTTPS review
  reference bind the stable manifest to the retained object.
- Changing CDN, load balancer, ingress, forwarding behavior, or trusted proxy
  configuration invalidates the prior boundary evidence and requires a new
  run.
