# API transport security

BYOK Grid validates domain payloads with strict schemas, but schema validation
happens only after transport bytes arrive. The Next.js App Router delegates
`request.json()` to the Web Request API and does not apply the Pages Router's
body-parser limit. Every product Route Handler therefore reads JSON through the
shared bounded reader in `apps/web/src/lib/request-body.ts`. The dependency-owned
Better Auth POST handler uses the same streaming boundary and receives a replay
of the accepted bytes.

## Request limits

| API surface                       | Byte limit | Additional limits                        |
| --------------------------------- | ---------- | ---------------------------------------- |
| Better Auth POST requests         | 64 KiB     | Better Auth's endpoint validation        |
| Normal product JSON mutations     | 5 MiB      | Route-specific strict schemas            |
| Token-scoped push-ingestion batch | 5 MiB      | 500 records and 100 fields per request   |
| Authenticated CSV import          | 50 MiB     | 100,000 rows and 1 MiB per parsed record |

The normal JSON reader rejects a declared size above the limit before domain
parsing and cancels the request stream. It also counts the bytes actually read,
so missing or understated `Content-Length` headers and chunked transfer do not
bypass the ceiling. Exactly-at-limit UTF-8 input is accepted. Malformed lengths
receive `400`, unsupported compressed request bodies receive `415`, and
oversized bodies receive `413`; these transport responses are non-cacheable.

Malformed JSON remains a route-level validation concern, preserving each API's
existing `400` or `422` contract. Authenticated product routes resolve the
session before reading their request body, so an unauthenticated request does
not make the application buffer its supplied payload. Authentication endpoints
must read credentials to create or verify a session, which is why their
separate ceiling is substantially smaller.

The five-MiB generic limit is intentionally larger than a typical form. A
published workflow may contain up to 100 nodes, 200 edges, and bounded mapping
configuration, while a single editable cell may contain up to 256 KiB. Lowering
the transport boundary without also reducing those product contracts would
make valid data impossible to save.

## Proxy and ingress alignment

Set route-aware limits at the TLS proxy or ingress as the first layer, but keep
the application checks enabled because development servers, internal traffic,
and alternate ingress paths can bypass a particular proxy. A global five-MiB
proxy ceiling would break the supported CSV import. Configure at least these
distinct paths:

- `/api/auth/*` POST routes: 64 KiB;
- normal product and invitation JSON routes: 5 MiB;
- `/api/ingest/*`: 5 MiB; and
- authenticated CSV import routes: 50 MiB.

Reject request decompression at the edge or preserve the application's
identity-only request encoding rule. Response compression is independent and
may remain enabled. Configure slow-body, header-size, connection, concurrency,
and request-duration limits in the HTTP server, ingress, or load balancer; a
byte ceiling alone does not stop slow uploads or request floods.

## Regression and deployment tests

The web test suite recursively inspects every App Router API file. It fails if
a route calls `request.json()` directly or fails to return the bounded reader's
transport response before schema parsing. A separate source contract protects
the Better Auth POST wrapper. Unit tests prove declared-length rejection,
chunked-body cancellation, replay fidelity, UTF-8 byte accounting, malformed
input handling, compressed-body rejection, and both production ceilings.

Before cutover, send both declared and chunked requests immediately below, at,
and above each configured edge limit. Confirm the edge and application agree,
the response statuses remain stable, memory does not grow with the attempted
payload, and ordinary valid workflows, ingestion batches, and CSV files still
succeed.

These controls are not rate limits. Production operators must also enforce
authenticated and unauthenticated request-rate, concurrent-request, and
connection limits at the edge. Application-level tenant quotas remain a
separate product policy and should not reuse Better Auth's internal rate-limit
table.
