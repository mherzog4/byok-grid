# API transport security

BYOK Grid validates domain payloads with strict schemas, but schema validation
happens only after transport bytes arrive. Every product Route Handler reads
JSON through the bounded reader in `apps/web/src/lib/request-body.ts` instead of
calling the unbounded App Router `request.json()` helper.

## Request limits

| API surface                       | Byte limit | Additional limits                      |
| --------------------------------- | ---------- | -------------------------------------- |
| Normal product JSON mutations     | 5 MiB      | Route-specific strict schemas          |
| Token-scoped push-ingestion batch | 5 MiB      | 500 records and 100 fields per request |
| CSV import                        | 50 MiB     | 100,000 rows and 1 MiB per record      |

The normal JSON reader rejects a declared size above the limit before domain
parsing and also counts bytes actually read, so chunked or understated bodies
cannot bypass the ceiling. Malformed lengths receive `400`, compressed bodies
receive `415`, and oversized bodies receive `413`. These transport responses
are non-cacheable.

The five-MiB generic limit is intentionally larger than a typical form. A
published workflow may contain up to 100 nodes and 200 edges, while one editable
cell may contain up to 256 KiB. Lowering the transport boundary without reducing
those product contracts would make valid data impossible to save.

## Browser mutation origin boundary

The Next.js Proxy matches the complete `/api/*` surface. `GET`, `HEAD`, and
`OPTIONS` pass through. Every other method rejects cross-site Fetch Metadata or
an `Origin` that differs from `BYOK_GRID_PUBLIC_URL`. When that optional setting
is empty, local clones use the request origin. A same-origin `Referer` is the
fallback when `Origin` is absent.

Headless capability clients such as the Airbyte destination remain supported:
an unsafe request with no browser provenance passes to the route, where its
Bearer token, content type, payload, and idempotency key are still validated.
The application does not enable cross-origin resource sharing.

`BYOK_GRID_PUBLIC_URL`, when set, must contain only an HTTP(S) scheme, hostname,
and optional port. Public deployments require HTTPS. A path, credentials,
query, or fragment makes readiness fail. The reverse proxy must preserve
`Origin`, `Referer`, and `Sec-Fetch-*` request headers.

## Local access model

BYOK Grid has no signup, sign-in, session cookie, or invitation API. A stable
local owner is provisioned in SQLite and every workspace query remains scoped
to that owner. This preserves repository and foreign-key integrity; it is not a
remote-user authentication boundary.

Keep development on loopback. Any installation exposed beyond a trusted device
or private network must sit behind an operator-controlled VPN,
identity-aware proxy, or equivalent ingress policy. BYOK Grid does not consume
upstream identity headers and should not be exposed as an unauthenticated public
SaaS service.

## Response headers and diagnostics

Every response includes a server-generated UUIDv4 in `X-Request-ID`. The Proxy
replaces caller-supplied request IDs. Unexpected API failures return a generic
`500` with that ID and log only bounded event metadata; paths, queries, bodies,
credentials, and workspace identifiers are excluded.

Application responses carry a fresh request-scoped CSP nonce. The script policy
enables `strict-dynamic` and permits neither production `unsafe-inline` nor
`unsafe-eval`. The server also emits one-year HSTS, no-referrer, anti-framing,
MIME-sniffing, and browser-capability restrictions, and disables framework
identification. A TLS proxy must preserve these headers and must not cache
nonce-bearing HTML across requests.
