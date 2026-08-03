# ADR 0020: Saved typed grid views

## Status

Accepted.

## Context

A large enrichment table is not useful if every member must repeatedly scan or
export it to find failed cells, qualified accounts, or incomplete records. The
grid already uses keyset pagination and typed sparse cells, but its only query
order was manual row position.

Adding ClickHouse to solve this control-plane interaction would create a second
consistency model for mutable cells, workspace authorization, and read-after-
write behavior. PostgreSQL already owns those records and has column/value
indexes suitable for interactive bounded predicates.

## Decision

`saved_grid_views` stores shared, table-scoped definitions using immutable
column IDs. A definition contains a normalized name, a bounded recursive filter
tree, and zero or one sort. Groups explicitly join children with `AND` or `OR`.
Each table may retain at most 50 views. The tree permits at most 12 leaf
predicates, three group levels, and eight children per group.

The filter contract is an allowlisted discriminated union:

- empty and non-empty work for every column type and treat a missing sparse cell
  as empty;
- text supports case-insensitive equality and substring matching;
- finite numbers support equality and greater/less comparisons;
- booleans support equality;
- timestamps support before/after comparisons;
- run status supports the persisted cell state; and
- JSON supports emptiness and status only.

The database validates every referenced column as active and checks the
operator against its declared value type. A recursive compiler assembles SQL
only from fixed operator and combinator branches; authored values remain bound
parameters. Empty roots mean no filtering, while empty nested groups are
rejected. Existing flat filter arrays are upgraded to a canonical root `AND`
group when read and by the schema migration.

Sorted pages use a cursor containing the view ID, column ID, direction, typed
sort value, empty-value bucket, and row ID. Empty or missing cells sort last in
both directions. The row ID is the deterministic tie-breaker. A cursor from a
different view or sort is rejected rather than interpreted under new semantics.

Saved views are shared workspace resources. Forced RLS permits members to read
and mutate views only in workspaces they belong to, and inserts must attribute
the authenticated user. CSV export accepts the active view and walks the same
cursor contract.

Column archival is blocked while a saved view references that column. Table
archival retains its views through the table foreign key so restoration brings
the query definitions back with the same IDs.

## Consequences

- Filtering, sorting, and export remain read-after-write consistent with the
  authoritative grid.
- Saved definitions survive column renames because they reference IDs.
- The query planner can use the existing cell value indexes and the unique
  row/column index; text substring matching may still scan values for the
  selected column.
- Shared views are collaborative rather than private. Per-user private views
  and full-text/trigram search are explicit future extensions.
- ClickHouse remains appropriate for append-only usage analytics or aggregate
  dashboards, not mutable interactive grid semantics. Airbyte remains an
  optional ingestion adapter and does not participate in saved-view execution.
