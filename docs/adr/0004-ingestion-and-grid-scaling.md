# ADR 0004: PostgreSQL-staged imports and paged virtual grids

- Status: Accepted
- Date: 2026-07-31

## Context

A Clay-like table must ingest CSV data without loading an entire file into web
memory, survive worker restarts without duplicating rows, and display datasets
that are much larger than the browser viewport. Requiring object storage,
Airbyte, or an analytical database for ordinary CSV use would make the default
self-hosted installation unnecessarily difficult to operate.

## Decision

The Next.js control plane streams CSV request bytes through `csv-parse` with a
strict column count, BOM support, a one-MiB record ceiling, and fail-closed
syntax handling. Uploads are capped at 50 MiB, 100,000 data rows, and 256
columns. Parsed records are staged in tenant-scoped PostgreSQL rows in batches;
the complete file is never buffered in application memory.

After staging completes, the same transaction that marks the import queued
writes a transactional-outbox event. A Hatchet task resolves the header mapping
once and applies staged rows in transactional batches. Each batch inserts rows,
sparse cells, dependent formula results, and the progress checkpoint together.
Committed progress can therefore resume without duplicating rows. Successful
and syntactically failed uploads remove their staging records; terminal worker
failures retain them for future administrative retry tooling.

CSV headers reuse case-insensitive matches to editable input columns. A
collision with a formula or connector column creates a suffixed input column.
This behavior is isolated in the domain import-policy seam.

Grid reads use an opaque keyset cursor over row position and row ID. Each API
page contains at most 200 rows and only their cells. The React client uses
TanStack Virtual with stable row IDs, measurement, and overscan, so mounted DOM
work is bounded by the viewport rather than the loaded page count. Individual
edits and run polling refresh only the affected row.

CSV export streams the same cursor pages. Every field is quoted, and values
that can trigger spreadsheet formula execution are prefixed before download.

The initial local-development baseline on 2026-07-31 fetched a 100-row sparse
page from a 2,000-row table in a 2.09 ms mean and 4.39 ms p99 across 239 samples.
This is a regression baseline for the query shape, not a production latency
promise; contributors can reproduce it with `npm run benchmark:grid`.

## Airbyte and object-storage boundary

Airbyte remains an optional adapter for scheduled synchronization from external
systems; it is not used for core CSV uploads. The default import limits make
PostgreSQL staging operationally reasonable. A future large-object adapter may
stage substantially larger files in user-owned S3-compatible storage without
changing import-job or worker semantics.

## Consequences

- PostgreSQL temporarily stores staged text rows during active or retryable
  failed imports.
- Large imports require the long-running Node deployment profile; short-lived
  serverless request limits are not a supported ingestion target.
- Keyset pagination does not provide a frozen transaction snapshot while rows
  are concurrently appended; durable snapshot exports can be added as jobs.
- The headless virtualizer avoids an enterprise-grid licensing boundary while
  leaving column and cell UX under project control.
