# ADR 0043: Generate trusted request correlation at the application boundary

- Status: Accepted
- Date: 2026-08-03

## Context

Production incidents need a stable way to connect a client-visible API failure
to the corresponding server diagnostic. BYOK Grid previously emitted generic
500 responses and separate route-local logs, so an operator could not identify
the relevant event without searching by time and potentially enabling more
verbose, sensitive logging.

Accepting an inbound `X-Request-ID` is not safe across every self-hosted
topology. A direct client can spoof that header unless every ingress path
overwrites it correctly. Reusing one header for internal propagation and public
responses also makes it easy to accidentally trust caller-controlled data.

## Decision

The Next.js Proxy generates a random UUIDv4 for every application request. It
deletes inbound `X-Request-ID` and `X-BYOK-Grid-Request-ID`, forwards the new
value to Route Handlers only under the private header, and returns the same
value publicly as `X-Request-ID`. Proxy-level rejections receive the generated
response header without reaching a route.

Unexpected API exceptions use one shared helper. It emits a generic 500 body
containing the request ID and one JSON log event containing only a fixed area,
the bounded exception class name, a fixed event name, and the request ID. It
does not emit exception messages, stacks, URLs, queries, payloads, workspace or
user identifiers, or credentials. A direct Route Handler invocation without
the Proxy receives a new fallback UUID.

Expected validation, conflict, access, and rate-limit failures retain their
existing 4xx contracts. The public request ID is a diagnostic join key only and
never participates in authentication, authorization, idempotency, or tenancy.

## Consequences

- Clients can report one opaque ID that identifies the corresponding sanitized
  application failure event.
- Caller-supplied correlation values cannot forge application log identity.
- Ingress and centralized logging must preserve `X-Request-ID` and the JSON log
  record without attaching sensitive request bodies, queries, or credentials.
- Correlation across systems upstream of the Next.js boundary requires a
  separately reviewed trusted-proxy design; this decision intentionally does
  not trust arbitrary inbound trace headers.

## Verification

Unit tests prove canonical UUID generation, trusted-header validation, fallback
generation, consistent header/body/log IDs, and redaction of sensitive messages,
URLs, and unsafe exception names. A recursive source contract rejects route-
local unexpected logging, direct route 500 responses, and error helpers called
without the request. Proxy tests prove both inbound header names are replaced.
The compiled standalone drill verifies unique server IDs on successful,
application-rejected, and proxy-rejected HTTP responses.
