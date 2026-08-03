# ADR 0023: Token-scoped push ingestion as the Airbyte boundary

- Status: Accepted
- Date: 2026-08-01

## Context

The built-in scheduled HTTPS source is intentionally small, but a Clay-like
workspace eventually needs a much broader catalog of databases, CRMs, and
warehouses. Airbyte is useful for that catalog. Embedding Airbyte in the core
runtime would also add another control plane, release lifecycle, credential
store, and operational dependency to every self-hosted installation.

A bulk destination cannot update grid rows directly in a public request. A
delivery may be retried, two deliveries may overlap, formulas must recompute,
and row-settlement automations must observe the same mutation contract as
manual edits and built-in sources.

## Decision

Expose a provider-neutral push-ingestion contract at
`POST /api/ingest/:endpointId`. Workspace owners and admins create a
table-scoped endpoint and receive a high-entropy bearer token exactly once.
Only its SHA-256 digest and a display prefix are stored.

Each request must include:

- `Authorization: Bearer <token>`;
- a caller-stable `Idempotency-Key`;
- `Content-Type: application/json`; and
- one to 1,000 flat scalar records in `{"records": [...]}`.

The Next.js route reads at most 5 MiB, normalizes scalar values, calculates an
exact-body digest, and commits a batch, staged records, and an outbox event in
one SQLite/libSQL transaction. A replay with the same endpoint, idempotency key,
and digest returns the original batch. Reusing the key with another body is a
conflict.

The public route never receives a workspace-wide capability. Every endpoint,
staging, and status query requires both the endpoint ID and a constant-shape
SHA-256 token digest; the raw token is never stored. Revocation immediately
prevents new staging and status reads.

Hatchet applies each accepted batch asynchronously. SQLite-owned record
identities upsert stable keys, input columns evolve up to the existing 100-field
limit, and normal row-settlement events are queued for connector and outbound
nodes. Batches for one endpoint are applied in acceptance order so concurrent
deliveries cannot race to define the final row state.

## Airbyte boundary

Airbyte remains optional and user-owned. Its main repository currently uses
[Elastic License 2.0](https://github.com/airbytehq/airbyte/blob/master/LICENSE),
so the project does not bundle or describe the Airbyte platform as an
OSI-licensed core dependency. The repository instead includes a separately
Apache-2.0-licensed, language-agnostic destination executable that implements
Airbyte's public Docker protocol without importing Airbyte code. It groups
records into the stable HTTP envelope and acknowledges source state only after
grid application succeeds.

The adapter receives only endpoint URLs and their table-scoped tokens; it never
receives BYOK Grid's database credentials, workspace master key, or provider
credentials. No Airbyte platform image is included in the default Compose
stack.

This same contract works with other ELT tools, scheduled jobs, and customer
code. The core therefore depends on an ingestion protocol rather than one
vendor's deployment or connector SDK.

## ClickHouse boundary

ClickHouse does not participate in ingestion authorization, row upserts,
formulas, or batch status. The optional ClickHouse projector consumes completed
ingestion metrics for aggregate throughput analytics. That projection is
rebuildable; SQLite/libSQL remains authoritative.

## Consequences

- The default installation stays Next.js, SQLite/libSQL, Hatchet, and the Node
  workflow worker.
- Public requests return `202 Accepted` quickly and can be polled by batch ID.
- Exact-body idempotency is predictable but callers must reuse identical bytes
  when retrying a key.
- Push ingestion currently supports upsert only. Delete propagation,
  soft-delete markers, and schema contracts are future protocol versions. The
  optional Airbyte destination preserves source checkpoints by delaying every
  `STATE` acknowledgement until prior batches report success.
- Endpoint tokens cannot be recovered; operators rotate by creating a new
  endpoint and revoking the old one.
