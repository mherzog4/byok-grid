# ADR 0030: Previewed atomic input-column type conversion

- Status: Accepted
- Date: 2026-08-01

## Context

Typed columns are useful only if a workspace can evolve its schema without
exporting and rebuilding a table. Changing only the column declaration would
leave stored cells with incompatible discriminants, while converting cells one
at a time would expose a mixed schema to imports, source syncs, formulas,
writebacks, and concurrent editors.

Type coercion is also a data-loss policy. Inputs such as `1`, `true`, local
timestamps, and JSON objects have several plausible interpretations. A safe
open-source default must be deterministic across deployments and must show the
operator what will fail before it mutates authoritative data.

## Decision

An owner or admin may convert an active input column among `text`, `number`,
`boolean`, UTC `timestamp`, and `json`. The control plane first scans every
explicit cell and returns counts, at most ten row-level failure samples,
structural blockers, and a SHA-256 preview digest. Conversion requires the
exact column name and that digest.

The mutation re-runs the complete preview inside one PostgreSQL transaction.
It takes an exclusive table cell-schema advisory lock; manual edits, CSV import
batches, scheduled-source pages, and push-ingestion batches take the matching
shared lock. A changed cell version invalidates the digest, so confirmation
cannot apply to a stale preview. Every non-empty value, the column declaration,
and an actor-scoped `column_type_converted` lifecycle event commit together or
roll back together. Explicit empty cells are preserved without a version bump.

The initial conversion matrix is deliberately conservative:

- any non-empty scalar or JSON value may become canonical text;
- text may become a finite number, exact `true`/`false`, JSON parsed from the
  complete string, or a timestamp only when it includes `Z` or an explicit UTC
  offset;
- a JSON string delegates to the equivalent text rule, and matching JSON
  number/boolean primitives may become their scalar type;
- number, boolean, and timestamp values may become JSON primitives;
- ambiguous conversions such as `1` to boolean, JSON objects to scalars, and
  offset-free timestamps fail the preview.

The operation is blocked by conversion failures, active cell/import/source/
ingestion work, dependent active formula or connector columns, active source
or ingestion mappings, any writeback reference, and any saved-view reference.
It deliberately does not enqueue enrichment, formula settlement, webhooks, or
writebacks: this is a schema migration, not a sequence of user row edits.

Conversion has no automatic reverse snapshot. Canonicalization can discard
formatting—for example text `007` becomes number `7`—so operators that require
byte-for-byte rollback must export or back up the table before confirming.

## Airbyte and ClickHouse boundary

CSV, scheduled-source, and push-ingestion schema planners reuse only text input
columns. If a later source field name collides with a converted non-text input,
the planner creates a suffixed text column instead of coercing untrusted source
data into the new type. Active mappings must be paused or revoked before a
conversion and can then be reviewed explicitly.

The optional Airbyte destination continues to deliver provider-neutral staged
records through push ingestion and does not own type conversion. The optional
ClickHouse projector receives terminal analytics events only; it neither
previews nor applies mutable PostgreSQL schema changes.

## Consequences

- A table can evolve an existing input schema without ever exposing mixed cell
  types.
- Operators see deterministic failures and dependencies before confirmation.
- Concurrent product write paths cannot cross the conversion transaction.
- Conservative coercion rejects some inputs a human might consider obvious;
  those cells must be normalized explicitly first.
- Reversible archive behavior and irreversible value canonicalization remain
  separate lifecycle concepts.
