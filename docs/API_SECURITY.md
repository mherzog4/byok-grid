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

## Session lifecycle

Public origins default to a hard seven-day database-backed session. Sliding
refresh is disabled unless an operator explicitly enables it; loopback
evaluation keeps sliding refresh enabled for contributor convenience. Runtime
configuration accepts an expiry from 15 minutes through 30 days and a refresh
age of at least one minute that must remain shorter than the expiry. Invalid or
internally inconsistent values make readiness fail.

Better Auth's cookie cache is disabled so database revocation takes effect on
the next authenticated request. The account page compares session tokens only
inside server code and sends the browser an integer count of other active
sessions. A user can revoke those sessions without invalidating the current
one. The Next.js boundary returns `404` for external requests to Better Auth's
raw-token-bearing session-list endpoint; internal server calls do not traverse
that route. Other-session tokens must not be logged, rendered, or exposed
through product API responses. Production provider delivery remains a separate
deployment gate; bounded sessions do not replace account recovery.

## Authentication email and recovery

SMTP delivery is opt-in and structurally validated at startup. Non-loopback
SMTP must use implicit TLS or require STARTTLS; certificate verification and a
TLS 1.2 minimum remain enabled. Credentials are accepted only as a complete
username/password pair, header fields reject control characters, and generated
messages cannot read files or URLs. SMTP debug and protocol logging are off.
The delivery boundary refuses any authentication URL outside the canonical
`BETTER_AUTH_URL` origin and `/api/auth/*` route.

Verification and reset links expire after one hour. Reset tokens are stored in
the Better Auth verification table, consumed once, and every active session is
deleted after a successful password change. Known and unknown reset requests
return the same response even when SMTP delivery fails. The failure diagnostic
contains only the email kind, never the recipient, URL, SMTP response, or
exception. The Next route wrapper gives reset and verification requests a
500-millisecond minimum response time across success, unknown-account,
validation, and outage paths. Better Auth applies its database-backed three-
per-minute special rate-limit bucket.

By default, BYOK Grid gives Better Auth no client-IP headers. Authentication
requests therefore share a fail-closed per-route bucket and rotating a forged
`X-Forwarded-For` value cannot bypass the limiter. A deployment may set
`BYOK_GRID_AUTH_TRUSTED_PROXY_CIDRS` to exact proxy IPs or bounded CIDRs; Better
Auth then walks `X-Forwarded-For` from right to left and keys the first
untrusted hop. Startup rejects malformed, duplicate, excessive, and `/0`
entries. This opt-in is safe only when the selected ingress overwrites or
appends the header predictably and direct web access is denied. Forwarded host
and protocol headers remain untrusted. Edge rate limiting remains required for
distributed volume, connection, and non-authentication abuse controls.

Token-bearing `/reset-password` responses are private and non-cacheable, carry
`X-Robots-Tag: noindex, nofollow`, and inherit `Referrer-Policy: no-referrer`.
Do not log reset or verification URLs. SMTP server responses may contain
recipient metadata and must receive the same centralized-log redaction policy
as other identity data.

The five-MiB generic limit is intentionally larger than a typical form. A
published workflow may contain up to 100 nodes, 200 edges, and bounded mapping
configuration, while a single editable cell may contain up to 256 KiB. Lowering
the transport boundary without also reducing those product contracts would
make valid data impossible to save.

## Browser mutation origin boundary

The Next.js Proxy matches the complete `/api/*` surface. `GET`, `HEAD`, and
`OPTIONS` pass through. Every other method rejects cross-site Fetch Metadata or
an `Origin` that differs from the canonical `BETTER_AUTH_URL` origin. A
same-origin `Referer` is the fallback when `Origin` is absent. Cookie-bearing
mutations with neither header fail closed.

Headless capability clients such as the Airbyte destination remain supported:
an unsafe request with no cookie and no browser provenance passes to the route,
where its Bearer token, content type, payload, and idempotency key are still
validated. The application does not enable cross-origin resource sharing.
Better Auth also retains its own endpoint-specific CSRF and origin validation;
its fixed base URL is not inferred from forwarded proxy headers.

`BETTER_AUTH_URL` must contain only an HTTP(S) scheme, hostname, and optional
port. Production requires HTTPS. A path, credentials, query, or fragment makes
the web runtime invalid. The TLS proxy must preserve `Origin`, `Referer`, and
`Sec-Fetch-*` request headers rather than removing or rewriting them.

## Response headers

Every application response includes a server-generated UUIDv4 in
`X-Request-ID`. The Next.js boundary removes caller-supplied `X-Request-ID` and
`X-BYOK-Grid-Request-ID` values, forwards the generated ID internally, and
returns it publicly. The ID is an opaque diagnostic join key, not an identity,
authorization, tenant, or idempotency value.

Unexpected API exceptions return a generic `500` body with the request ID and
emit one structured JSON event containing only `event`, `area`, `errorName`,
and `requestId`. Exception messages, stacks, request paths and queries,
payloads, user or workspace identifiers, and credentials are excluded. Expected
validation, access, conflict, and rate-limit failures retain their specific 4xx
contracts and receive the global response header from the Proxy.

A TLS proxy must preserve the application's response `X-Request-ID`. It must
not copy an arbitrary inbound value into the private internal header or treat a
request ID as proof that a request is trusted. Centralized HTTP access logs may
record the response ID alongside bounded method, status, duration, and route
template fields, but should not add raw queries, bodies, cookies, or
authorization headers.

Every application response carries a request-scoped CSP nonce. The script
policy requires that nonce, enables `strict-dynamic`, and permits neither
`unsafe-inline` nor `unsafe-eval` in production. Every server-rendered script
must carry the exact nonce from its response header. Inline styles remain
allowed because the virtualized grid and workflow canvas calculate styles at
runtime.

The same responses carry one-year HSTS, no-referrer, anti-framing,
MIME-sniffing, and browser-capability restrictions. Invitation pages
additionally use a private, no-store cache policy, and framework identification
is disabled. HSTS is effective only when received over HTTPS; the TLS proxy must
preserve it. The application does not claim `includeSubDomains` or preload
because those are domain-wide operator decisions.

The application renders HTML dynamically so each request receives a fresh
nonce. A reverse proxy or CDN must preserve the CSP exactly and must not cache
nonce-bearing HTML for reuse across requests. Static Next.js assets are excluded
from nonce generation and may retain their normal immutable caching behavior.

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
the Better Auth POST wrapper. The correlation source contract also rejects
route-local unexpected logging, direct route 500 responses, and error helpers
that omit the trusted request. Unit tests prove declared-length rejection,
chunked-body cancellation, replay fidelity, UTF-8 byte accounting, malformed
input handling, compressed-body rejection, and both production ceilings. The
origin suite proves safe-method behavior, same-origin Origin/Referer handling,
cross-site and missing-provenance rejection, headless-client compatibility, and
Proxy wiring. The header suite freezes the global and invitation policies.

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

Before production promotion, use the
[`production ingress boundary drill`](INGRESS_BOUNDARY_DRILL.md) from two real
client networks. It distinguishes application and edge `429` responses, binds
the observed forwarding chain to the trusted-proxy configuration, and requires
direct-origin denial rather than inferring those properties from public health.
