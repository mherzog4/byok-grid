# ADR 0024: Optional, rebuildable ClickHouse event projection

- Status: Accepted
- Date: 2026-08-01

## Context

PostgreSQL owns mutable cells, credentials, run state, budgets, and tenant
authorization. Those workloads need transactions and row-level security. At
larger event volumes, repeatedly aggregating historical executions in that same
database would compete with interactive grid traffic.

ClickHouse is Apache-2.0 software and is designed for analytical event scans.
It is useful only if adding it does not make a small self-hosted installation
harder, create another authorization authority, or cause an analytics outage to
block product work.

## Decision

Ship a standalone `analytics-projector` image and an opt-in Compose profile.
Neither the web application nor the main worker connects to ClickHouse. The
projector reads an explicit allowlist of terminal events from PostgreSQL's
transactional outbox using the worker database role.

Every outbox event has projection-specific lease, retry, error, and completion
fields. These are independent from `published_at`, which belongs exclusively to
Hatchet dispatch. A transaction claims rows with `FOR UPDATE SKIP LOCKED`; an
expired lease can be reclaimed by another projector. A failed request releases
the lease with bounded exponential backoff. Core work never waits for this
path.

The only projected event types are:

- `cell.run_succeeded`
- `cell.run_failed`
- `table.csv_import_succeeded`
- `table.ingestion_batch_succeeded`
- `table.source_run_succeeded`

Each payload passes a strict, event-specific public schema. Unknown event types,
extra payload fields, secrets, provider responses, prompts, cell values, and
row snapshots are not projected.

The projector inserts newline-delimited `JSONEachRow` over ClickHouse's HTTP
interface. Credentials use `X-ClickHouse-User` and `X-ClickHouse-Key` headers;
URLs cannot contain credentials, queries, or fragments. HTTPS is mandatory
outside an explicit local-development escape hatch, redirects are denied, and
responses are bounded.

The target uses `ReplacingMergeTree(projected_at)` ordered by
`(workspace_id, event_id)`. Delivery is at least once: a crash after ClickHouse
accepts a batch but before PostgreSQL records completion can create a duplicate
version. Background merges remove old versions; queries requiring immediate
deduplication use `FINAL`. This follows the official
[ReplacingMergeTree guidance](https://clickhouse.com/docs/guides/replacing-merge-tree)
and [HTTP interface](https://clickhouse.com/docs/interfaces/http).

## Data ownership and recovery

ClickHouse is a derived copy. It cannot authorize a run, enforce provider spend,
answer current cell state, or supply an ingestion acknowledgement. Projection
checkpoints remain in PostgreSQL. The entire ClickHouse table may be discarded
and rebuilt from retained allowlisted outbox events by an explicit operator
procedure.

The repository pins an LTS image for the evaluation profile. Production
operators should follow ClickHouse's supported-release policy, use a dedicated
least-privilege account, encrypt transport, configure backups and retention,
and upgrade independently from BYOK Grid.

## Consequences

- The default stack remains Next.js, PostgreSQL, Hatchet, and TypeScript
  workers.
- Analytics can lag or be unavailable without affecting product correctness.
- PostgreSQL retains a small amount of delivery metadata per outbox event.
- Exact recent aggregates need `FINAL`; approximate/eventually deduplicated
  dashboards can avoid its query cost.
- Adding a new projected event requires reviewing and extending the strict
  domain contract; arbitrary outbox forwarding is forbidden.
