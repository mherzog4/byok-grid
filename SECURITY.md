# Security policy

## Supported versions

BYOK Grid has not published a stable release. Security fixes currently target
the latest commit only.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository
host's private security-advisory feature. If that feature is unavailable,
contact a maintainer through a private channel listed in the repository
metadata before sharing reproduction details.

Include the affected component, impact, reproduction conditions, and any known
mitigations. Never include real API keys, session cookies, customer data, or
other secrets in a report.

Maintainers should acknowledge a report within five business days, coordinate
a fix and disclosure timeline with the reporter, and credit the reporter when
requested and safe.

## Deployment warning

The default Hatchet image in `docker-compose.yml` disables authentication and
is for local development only. Do not expose it to a network or deploy it in
production. Production deployments must use authenticated, pinned workflow
infrastructure and unique database, auth, and encryption secrets.

The Dockerfile runs both application targets as the unprivileged `node` user.
Official images contain no deployment-specific build arguments. Never place
database URLs, auth secrets, Hatchet tokens, workspace encryption keys, provider
credentials, or operator origins in build arguments or image layers. The
Compose `app` profile still depends on the auth-disabled local
Hatchet image and fixed local database passwords, so it is an evaluation path,
not a production manifest. Follow `docs/SELF_HOSTING.md` before exposing a
deployment.

npm installs run with strict lifecycle-script review. The root `allowScripts`
policy permits only esbuild's platform-binary validation and unrs-resolver's
native-package preparation; Hatchet's informational version warning and
protobufjs's dependency-style warning remain explicitly denied, as does the
optional fsevents native rebuild because its macOS binary ships in the package.
Dependency updates that introduce or change lifecycle scripts must receive
source review before the policy changes.

GitHub Actions in ordinary CI and the release workflow are pinned to full
commit SHAs, with reviewed version labels retained as comments. Do not replace
those pins with mutable major, version, branch, or `latest` references. Action
updates must review upstream release notes, the resolved commit, permissions,
and any nested action or binary download behavior before changing a pin.

The Dockerfile frontend, release bases, CI service containers, and
Compose-owned third-party images retain a readable version tag but are pinned
to an exact multi-platform manifest digest. The release verifier rejects
mutable replacements. Digest updates are security changes: review upstream
provenance and release notes, confirm both amd64 and arm64 manifests, rebuild
every target, and rerun image scanning before accepting them.

The workflow worker exposes unauthenticated Prometheus endpoints for Hatchet
health/process data and database-backed application gauges on separate ports.
The application endpoint deliberately omits tenant labels, payloads, provider
details, and errors, but both endpoints are operational metadata and must not
be published through application ingress. Limit access to readiness probes and
the cluster monitoring identity with network policy.

The SHA-pinned security workflow runs CodeQL dataflow analysis for
JavaScript/TypeScript and a locked Rust build on pushes, pull requests, and a
weekly schedule. Pull requests also reject newly introduced runtime
dependencies with known Moderate-or-higher advisories. Repository owners must
enable code scanning, dependency graph, Dependabot alerts, secret scanning, and
push protection in the public repository settings and make the security jobs
required before stable release.

The built-in HTTP connector pins DNS answers and rejects private, loopback,
link-local, reserved, benchmarking, documentation, and multicast networks.
Production deployments must also enforce private-network egress denial outside
the application as defense in depth.

Formula expressions are interpreted from a bounded typed tree and never passed
to JavaScript evaluation. Waterfall result paths traverse only own properties
of parsed provider responses. Provider credentials are resolved by ID and
decrypted only in the worker immediately before the corresponding request.
Installed provider actions derive fixed host allowlists from reviewed manifests,
not mutable workspace configuration. Provider API keys must never enter action
inputs, column configuration, outbox payloads, or run records. Built-ins are
build-time trusted code. Community modules run only in the optional
publisher-signed, digest-pinned Wasmtime sidecar, which rejects all imports and
receives no database URL, master key, filesystem, environment, or socket
capability. The Node worker mediates their bounded HTTPS effects through the
same DNS-pinned egress policy. Both Node and Rust authenticate the exact registry
bytes against administrator-configured Ed25519 public keys, then the runner
rechecks every artifact digest. Protect publisher private keys and the runner
RPC secret, verify public-key fingerprints out of band, and restart all three
services after registry or trust-set changes. Unsigned registry mode is a
local-development escape hatch and must never be enabled for production or
third-party artifacts. Signatures identify an approved publisher; they do not
replace manifest, source, schema, egress, and artifact review.

Community credential, input, and output schemas are compiled with strict
draft-2020-12 validation. Remote references, asynchronous schemas, coercion,
defaults, property removal, and schemas beyond the documented byte/depth/node
ceilings are rejected. Declarative credential fields must exactly cover a
closed credential object. Administrators must still review patterns and other
potentially expensive schema constraints; registry schemas are privileged
deployment configuration, not workspace-authored input.

AI connector inputs can contain sensitive workspace data. The OpenAI connector
sends the frozen prompt and optional instructions only to `api.openai.com`,
requests `store: false`, and stores the response ID, model, token usage, and
text in the workspace run history. Operators must still evaluate the selected
provider's current data-processing and retention terms; `store: false` is not
a promise of zero provider-side retention. Hatchet retries can repeat a metered
request after an ambiguous timeout because the Responses API does not provide
an exactly-once guarantee. Provider tracing IDs must never be mistaken for
idempotency keys.

Bulk runs require a server-generated preview and an exact confirmed row count.
The server freezes those row IDs and enforces deployment ceilings for selected
rows, worst-case provider requests, and OpenAI maximum output tokens. These
ceilings reduce accidental spend but are not monetary budgets: input size,
provider pricing, failures beyond the configured retries, waterfall matches,
and account-specific discounts
can change actual cost. Operators should set conservative limits and enforce
provider-side project budgets independently.

Client-rendered forms declare a native `POST` fallback. If a user submits before
React hydration finishes, credential and invitation fields therefore stay out
of the URL and browser history.

Scheduled HTTP source URLs are stored as non-secret configuration. URL
user-info, fragments, and common secret-bearing query parameters are rejected;
provider secrets must use an encrypted HTTP credential. Source fetches reuse
the DNS-pinned connector egress boundary, reject redirects and private or
reserved destinations, and accept at most five MiB per page, 25 pages, 5,000
flat records, and 100 fields per run. Remote pagination cursors are encrypted
with the workspace key and bound to their source run; raw cursors never enter
workflow or outbox payloads. A cursor source commits rows one page at a time.
If a safety limit stops the run, those rows remain visible while the run is
marked failed rather than complete. A successful sync replaces mapped
input-cell values for records it received, so operators should treat those
columns as source-owned. Missing records are preserved by default. Opt-in
archival is applied only in the same transaction that successfully completes
the final page; failed or partial runs cannot hide rows. The source identity
retains the archiving run as provenance, and a reappearing key restores the same
row. Push and Airbyte batches never imply deletion.

The native HubSpot contacts source accepts only a workspace-owned HubSpot
private-app token and can call only `api.hubapi.com`. Each run freezes a
half-open `hs_lastmodifieddate` window ending five minutes before observation
time, reducing the chance that search indexing delay creates a gap. The page
cursor is encrypted and bound to the run; the cross-run watermark is a
non-secret timestamp and advances only after the last page commits.
Incremental search results are not a complete contact inventory and therefore
cannot use missing-record archival or infer provider deletion. Selected
property names are validated configuration, not URLs, headers, filters, or
executable query text.

Push-ingestion bearer tokens are 256-bit random values shown once and stored
only as SHA-256 digests. They are table-scoped machine credentials, separate
from browser sessions and the encrypted provider vault. The SQLite repository
binds the digest to the matching active endpoint, table, staged batch rows, and
outbox request in one transaction. Requests are
limited to five MiB, 1,000 flat records, 100 fields, and 256 KiB per normalized
record. Exact-body idempotency rejects key reuse with different bytes. Never
put a token in a URL or log, require TLS, and revoke exposed tokens immediately.
Accepted batches are applied asynchronously and remain auditable after
revocation.

The optional Airbyte destination maps one stream to one endpoint, marks bearer
tokens as secret in its specification, requires HTTPS by default, denies HTTP
redirects, bounds response bodies, and emits no configuration or record data to
logs. It acknowledges Airbyte state only after prior batches succeed. Nested
values become canonical JSON strings; unsafe JavaScript integers are rejected
instead of rounded. `allow_insecure_http` is a development-only escape hatch
and must never cross an untrusted network.

The optional ClickHouse projector leases allowlisted events directly from
SQLite/libSQL and therefore runs in the same protected trust zone as the main worker. It
projects only strict allowlisted terminal metrics, uses independent expiring
leases, and never sends arbitrary outbox payloads. ClickHouse credentials are
header-only, HTTPS is required by default, redirects are denied, and response
bodies are bounded. The Compose password and plaintext internal endpoint are
local-evaluation defaults only. Production must use a dedicated least-privilege
ClickHouse account, secret-managed credentials, encrypted transport, and
network policy. ClickHouse is not an authorization source; every dashboard
query must be scoped by the workspace authorized in SQLite.

Outbound webhook endpoints must be credential-free HTTPS URLs. User-info,
fragments, and common secret-bearing query parameters are rejected, and every
delivery uses the same DNS-pinned private-network denial as connector traffic.
Redirects are not followed.

Webhook signing secrets are 256-bit base64url values stored in the workspace
vault. They are decrypted only in the worker and are absent from row snapshots,
outbox events, Hatchet inputs, logs, API responses, and delivery audit records.
The exact body is HMAC-SHA256 signed with a timestamp and delivery UUID.

Delivery bodies are immutable after queueing, limited to 512 KiB and 500
columns, and contain only the selected grid row. Receiver response bodies are
discarded. Operators must treat a destination as a data-egress grant and verify
the receiving service's retention and access controls before use.

Automatic webhook delivery is opt-in per destination. Row changes first create
a versioned settlement candidate; the worker sends only when that exact version
is still current and has no queued or running cells. This prevents stale
snapshots but does not prevent a receiver from creating an application-level
loop by writing the same data back into BYOK Grid. Deployments should use
receiver idempotency, scoped credentials, and external rate limits as defense in
depth. Failed and cancelled cells are considered terminal and are disclosed by
status in the signed payload.

HubSpot writeback credentials are private-app bearer tokens stored in the same
workspace envelope-encrypted vault. The writeback worker can call only
`api.hubapi.com`; workspace configuration supplies record and property mappings,
not a URL, method, headers, or arbitrary body. Delivery snapshots contain the
remote contact ID and mapped values, so they are workspace-sensitive data even
though they contain no credential. Database retention and access controls must
protect them accordingly. Only input cells and successfully settled computed
cells can enter a HubSpot snapshot; failed, cancelled, stale, queued, and
running mapped cells block the delivery because the remote property update
cannot preserve their local status metadata.

A HubSpot PATCH can be repeated after an ambiguous timeout. The payload contains
only property assignments and a stable delivery ID is sent as an idempotency
header, but operators must not assume the external API provides exactly-once
application.

Automatic writeback is opt-in and requires a non-empty bounded filter tree. It
runs only for an exact current row settlement, after all enrichment is terminal,
and only when a mapped, record-identity, or condition column changed. Each
delivery snapshots its condition. A destination/row/payload fingerprint unique
index suppresses a source loop that writes identical values back under a newer
row version; manual delivery remains the explicit retry path. The worker blocks
the complete writeback fan-out when matching destinations exceed
`AUTOMATIC_WRITEBACK_MAX_PER_ROW_CHANGE`, defaulting to five. This is an event
ceiling, not a provider quota; operators must retain HubSpot-side access and
rate controls.

Automatic enrichment is opt-in per connector column and defaults to manual.
The worker, not the browser, enforces `AUTOMATIC_RUN_MAX_PER_ROW_CHANGE`; a
change that exceeds the limit queues no providers. This limit counts connector
columns, not requests inside a waterfall, so operators must also review each
column's worst-case provider cost. Connector dependencies currently point only
to columns that already exist, preventing cycles. Any future dependency editor
must preserve cycle rejection and must not permit automatic actions to depend
on their own output, directly or transitively.

Table and input-column creation require authenticated workspace membership and
run through the same workspace-scoped SQLite repositories as row edits. The database service
serializes schema namespaces before checking the 100-table and 256-column
limits, preventing concurrent requests from racing past those ceilings. Table
selection is resolved only from the authenticated workspace's accessible table
list.

Table and column removal is implemented as owner/admin-only archival, never as
a cascading delete. The database service recomputes dependency, active
integration, and in-flight-work blockers while holding the schema namespace
lock; exact-name confirmation is not trusted as the only guard. Archived rows,
cells, configurations, mappings, runs, and immutable IDs remain stored. Every
transition appends an actor-bound, workspace-scoped event. Physical purge
and retention expiry are not implemented and must not be simulated by deleting
relational parents directly.

Saved grid views are shared workspace-scoped resources. Filter and
sort operators come from a fixed typed allowlist, referenced columns must be
active in the same table, and user-authored values are bound SQL parameters.
Recursive `AND`/`OR` groups are limited to 12 predicates, three levels, and
eight children per group before SQL compilation. Sorted cursors are tied to one
view definition and rejected when reused with a different view or order.

Bulk-run confirmation binds a domain-separated SHA-256 digest of the immutable
selection snapshot and exact ordered row IDs. The server recomputes that digest
inside the creation transaction, so a same-count row swap, sort change, or view
edit requires a new preview. Batch history retains the view definition even if
the shared view is later renamed or deleted; it contains workspace-sensitive
filter values and must remain under the batch table's workspace authorization policy.

Manual cell edits are limited to 256 KiB of UTF-8 value data in the shared
domain schema and revalidated by the database service. Browser `maxLength` is
not a security boundary. Numbers must be finite, timestamps must parse to a UTC
instant, and JSON must be valid JSON before it can replace a stored value.
Invalid drafts never enter row-settlement or automatic-enrichment state.

Formula source is parsed into the bounded shared expression tree; it is never
passed to JavaScript, SQL, a template engine, or an external evaluator. The
browser preview is not trusted. The authenticated database service resolves
column names inside the requested table, recompiles references to immutable
IDs, enforces source/tree limits and type rules, and persists explicit
dependency edges before any row is recomputed. Timestamp literals require an
explicit offset so formula results do not depend on worker locale.

Dirty column IDs are durable coordination metadata, not authorization. The
worker revalidates workspace, table, row, column, credential, and source-cell
scope when it queues each run. Failed provider outputs do not wake downstream
columns, while their terminal state can still allow an opted-in settled-row
webhook to proceed.

CSV imports fail closed on malformed records, inconsistent field counts,
oversized records, and configured upload limits. CSV exports quote every field
and neutralize values that spreadsheet applications could interpret as
formulas. Import errors must never log or return record contents.

Workspace invitations are bearer credentials. Only a domain-separated hash is
stored; the raw token is returned once, expires after seven days, and is bound
to the invited email during single-use transactional acceptance. Deployments
must preserve the global no-referrer policy and avoid logging invite URLs at
the reverse proxy, CDN, analytics, or tracing layer.

Workspace roles are enforced by centralized application policy, workspace-
scoped repositories, composite foreign keys, immediate write transactions, and
adversarial isolation tests. SQLite does not provide row-level security, so an
omitted workspace predicate is a security bug. Treat a stolen SQLite file or
libSQL credential as a full product-data compromise, and keep Hatchet's private
database credentials entirely outside BYOK Grid runtimes.
