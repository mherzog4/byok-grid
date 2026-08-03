# ADR 0015: Bounded multi-table and input-schema authoring

- Status: Accepted
- Date: 2026-07-31

## Context

An enrichment workspace is not useful if every workflow is forced into one
provisioned table with two fixed columns. Tables also scope imports, sources,
connector configurations, run history, webhooks, and CRM writebacks, so table
selection cannot be treated as a visual-only grid preference.

Schema mutation is more sensitive than editing a cell. Concurrent table or
column creation can bypass application limits, and partially creating a table
without an editable column leaves an unusable product state. Destructive
column or table deletion additionally needs explicit dependency and retention
semantics because PostgreSQL cascades can remove run history and audit state.

## Decision

Workspace members with the existing `data.write` capability can create and
rename tables and add text input columns. A table is created transactionally
with its first input column. Names are trimmed, Unicode-normalized, bounded to
120 characters, and compared case-insensitively within their scope.

The trusted database service enforces at most 100 tables per workspace and 256
columns per table. PostgreSQL advisory transaction locks serialize each
workspace table namespace and table column namespace, so concurrent API calls
cannot both pass a stale limit or duplicate-name check.

The active table ID is explicit in the `/app` query string. The Next.js server
component validates it against the selected workspace's accessible table list;
an absent or inaccessible ID falls back to the first table. Every table-scoped
client surface is keyed by table ID so local row, source, destination, and form
state cannot leak across table navigation.

Input columns can be authored as text, finite numbers, booleans, timestamps, or
JSON. Draft parsing, UTC conversion, JSON validation, and manual-cell size
limits are defined in ADR 0016. Existing input columns change type only through
the previewed atomic migration defined in ADR 0030.

Table and column deletion are intentionally excluded. Their future contract
must preview dependent formulas, connectors, sources, deliveries, and retained
audit records, then make destructive scope and recovery behavior explicit.

## Airbyte and ClickHouse boundary

An optional user-owned Airbyte adapter must target an explicit BYOK Grid table
ID and use the same 256-column ceiling; it cannot create unbounded schema behind
the control plane. An optional ClickHouse projection may copy table and column
identity into analytical events, but it does not own names, selection, or
schema mutation.

## Consequences

- A workspace can model independent prospect, account, and campaign datasets.
- Every existing enrichment and outbound feature now operates against the
  selected table rather than only the starter table.
- Concurrent schema creation has deterministic limits without a new service.
- Renaming is safe because dependencies use immutable IDs, not display names.
- Recoverable archive and type conversion remain explicit lifecycle workflows
  rather than generic column updates.
