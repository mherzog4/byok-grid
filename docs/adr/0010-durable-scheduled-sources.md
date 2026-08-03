# ADR 0010: Durable scheduled sources and adapter boundary

- Status: Accepted
- Date: 2026-07-31

## Context

A Clay-like workspace needs recurring ingestion from CRMs, warehouses, and
arbitrary APIs. Dynamic tenant schedules must survive restarts, avoid duplicate
rows, respect workspace credentials, and remain operable in the small default
self-hosted deployment. Airbyte can cover a broad catalog, but making it a core
dependency would add a second control plane and distribute source-available
components with different licensing and operational assumptions.

## Decision

SQLite owns source definitions, their next due time, immutable run records,
field mappings, and stable remote-record identities. A lightweight Node worker
scans due definitions inside an immediate write transaction, advances each
schedule, creates a source run, and writes the transactional-outbox event.
Hatchet durably executes that identifier-only run with retry and run-ID
idempotency; Hatchet's PostgreSQL database never becomes application state.

Missed intervals are coalesced. If a deployment is offline for six hourly
occurrences, startup creates at most one run and moves the next due time into
the future. This avoids an unreviewed provider-cost and load spike. Pause stops
future scheduling but does not interrupt a run already executing.

The first built-in adapter pulls one or more bounded HTTPS JSON responses. It:

- reuses workspace-encrypted HTTP bearer or API-key-header credentials;
- uses DNS-pinned egress that rejects private and reserved networks;
- disables redirects, bounds each body at five MiB, and caps a run at 5,000
  records and 25 pages;
- resolves an own-property-only dot path to a record array;
- accepts flat scalar records with at most 100 normalized fields;
- requires a stable record-key field and rejects duplicate keys; and
- creates or reuses text input columns through the existing import mapping
  policy.

Pagination is explicit rather than inferred. A source is either a
single-response source or a cursor source with a configured query-parameter
name, next-cursor response path, and page limit. The worker adds the current
cursor to the next request and uses a page-number-derived idempotency key.
Provider cursors are treated as credentials-adjacent opaque state: they are
encrypted with the workspace key and authenticated to the source-run ID.

Each page's row changes, cumulative counters, page number, and encrypted next
cursor commit in one immediate SQLite transaction. A retry therefore resumes after
the last committed page and an already-applied page is idempotent. A run is
successful only when the remote response returns no next cursor. Repeated
record keys across pages are rejected because processing one remote identity
twice could retrigger formulas, automations, or metered provider work.

When the configured page or total-record limit is reached while another cursor
exists, already-committed rows remain visible and the run fails with an
explicit partial-application message. This fail-closed result avoids presenting
a truncated dataset as a complete successful sync.

`(source_id, record_key)` maps each remote record to one grid row. A committed
retry therefore updates the same row. Each successful run replaces the mapped
input cells for records it received and atomically recomputes dependent formula
columns. Missing records default to `preserve`. A source may instead opt into
`archive`, which marks source-owned rows absent from the complete snapshot as
recoverably archived. Reappearing stable keys restore the same row and history.
Reconciliation runs only after the final page commits successfully; partial,
failed, or limit-truncated runs never infer deletion.

Source URLs are non-secret configuration stored in plaintext. URL user-info,
fragments, and common secret-bearing query parameters are rejected; credentials
belong in the BYOK vault and are decrypted only in the worker. Run and outbox
payloads contain IDs, never provider secrets or response records.

## Adapter and Airbyte boundary

The source definition stores an `adapter_id`. `http_json` provides the generic
snapshot boundary, while `hubspot_contacts` is the first trusted incremental
adapter. Provider adapters follow the connector security requirements:
deterministic validation, fixed capabilities, bounded responses, and explicit
credential and egress policies. Arbitrary third-party executable packages are
not dynamically installed in the web or worker process. See ADR 0028 for the
HubSpot watermark contract.

A future Airbyte bridge should target a user-owned Airbyte deployment. It may
trigger or observe an Airbyte sync and translate normalized destination records
into this same source-run/import boundary. BYOK Grid will store only Airbyte
connection references and encrypted API credentials; it will not bundle
Airbyte images in the default distribution or treat Airbyte as the per-cell
connector runtime.

ClickHouse remains an optional event projection for aggregate analytics. It
does not own source schedules, record identities, mutable grid rows, or
credentials.

## Consequences

- The default application stack stays Next.js, SQLite/libSQL, Hatchet, and a
  Node.js workflow worker. PostgreSQL remains private to Hatchet.
- Multiple processes coordinate source scheduling through SQLite's immediate
  transaction boundary and the unique scheduled-run constraint.
- The HTTP adapter supports explicit query-parameter cursor pagination, but
  intentionally omits hard deletes, nested records, offset/page-number
  inference, and provider-specific token exchange.
- Cursors add encrypted per-run state and page-level transactions, but do not
  add a second ingestion control plane to the default installation.
- A source can overwrite manually edited values in the input columns it owns;
  the UI identifies source behavior before creation.
- Recoverable missing-record archival adds row visibility state and source-run
  provenance while keeping SQLite authoritative.
- Repository membership predicates protect web access; the worker receives
  identifier-only jobs and re-resolves every source scope from SQLite.
