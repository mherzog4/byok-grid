# ADR 0016: Typed and bounded input editing

- Status: Accepted
- Date: 2026-07-31

## Context

The sparse-cell model already distinguishes text, finite numbers, booleans,
UTC timestamps, JSON, and empty values. Treating every browser edit as text
would make the displayed schema misleading, weaken formula and connector input
contracts, and force each downstream adapter to invent its own coercions.

Manual JSON editing also creates a separate resource boundary. A valid JSON
document can be arbitrarily large even when its syntax is simple, so relying on
request-server defaults would make storage and formula recomputation limits
implicit and deployment-dependent.

## Decision

Input columns have one editable value type: `text`, `number`, `boolean`,
`timestamp`, or `json`. The table manager exposes the type when a table's first
column or a later input column is created. Existing columns change type only
through the previewed, atomic migration in ADR 0030; ordinary cell writes never
coerce across the declared type.

The client converts editor drafts into the shared discriminated `CellValue`
union before sending them. The API and database service validate the same
bounded schema again. Empty drafts create the existing explicit `empty` cell;
text otherwise preserves whitespace, numbers must be finite, booleans use an
explicit empty/true/false selector, and JSON must pass the shared JSON schema.

Each manually written cell is limited to 256 KiB of UTF-8 value data. The
browser character limit is only an early convenience; the trusted domain and
database path perform the byte-accurate check.

The date-time control displays the stored instant in the browser's local time.
When edited, that local wall time is converted to a UTC ISO timestamp before
persistence. JSON is displayed in compact canonical `JSON.stringify` form
after a successful server round trip. Cell version keys remount uncontrolled
editors with canonical server values after writes or optimistic conflicts.

## Airbyte and ClickHouse boundary

An optional Airbyte adapter must map source fields into explicit BYOK Grid
types and report conversion failures; it cannot silently stringify everything.
An optional ClickHouse projection may preserve these type tags for analytics,
but PostgreSQL remains authoritative for the editable value and its version.

## Consequences

- Formula and connector inputs receive the types declared by the grid schema.
- JSON and timestamp values are editable without adding a second cell model.
- Invalid drafts remain visible with an error and do not overwrite the stored
  value.
- Very large manual values fail consistently across self-hosted deployments.
- Existing-column conversion has explicit preview, concurrency, failure, and
  audit semantics rather than weakening ordinary edit validation.
