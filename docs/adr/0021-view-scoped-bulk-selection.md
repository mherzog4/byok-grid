# ADR 0021: Exact saved-view selection for bulk runs

## Status

Accepted.

## Context

Saved views define the rows an operator sees, but the original bulk-run preview
considered the entire table and confirmed only an eligible-row count. A count
does not identify a set: one row can become ineligible while another becomes
eligible and leave the count unchanged. For a BYOK product, that can authorize
provider calls against rows the operator did not preview.

When a row limit is smaller than the matching set, selection order is also
material. A run launched from a sorted view must freeze the first rows in that
visible order, including the same null-last behavior as the grid.

## Decision

Bulk-run preview accepts an optional saved-view ID. The database resolves that
view within the authenticated workspace, applies its bounded allowlisted
filter tree through the same recursive compiler as the grid, then applies
input-readiness and run-mode predicates. Candidate rows use the saved view's
typed sort and deterministic row-ID tie-breaker before `rowLimit`.

The preview returns a domain-separated SHA-256 digest over:

1. an immutable snapshot containing the view ID, name, canonical filter tree,
   sort, and update timestamp; and
2. the exact ordered candidate row IDs.

Confirmation sends both the selected count and digest. A repeatable-read
transaction recomputes the selection and rejects any mismatch before creating
provider work. This catches same-count membership swaps, ordering changes, view
edits, and changes to input readiness or target-cell mode.

The batch persists the selection snapshot and digest alongside its frozen row
items. It deliberately does not retain a foreign key to the live saved view:
renaming or deleting a collaborative view must not erase execution provenance
or invalidate an already confirmed batch. Legacy all-row batches receive an
explicit all-row snapshot and zero digest during migration.

Legacy saved-view snapshots with a flat filter array remain readable and are
normalized to a root `AND` group before use. Historical provenance is not
rewritten merely to adopt the canonical representation.

## Consequences

- Operators can preview and run the rows represented by the active saved view.
- `rowLimit` means the first eligible rows in visible view order.
- Confirmation is stronger for both view-scoped and all-row runs because exact
  membership, not only count, is checked.
- Editing a row, view definition, sort value, input, or target status after
  preview may require a new preview. This is intentional cost authorization.
- View snapshots may contain sensitive filter values and remain protected by
  the existing forced-RLS batch policy.
- PostgreSQL remains the single read-after-write-consistent selection engine;
  no ClickHouse projection participates in provider-spend authorization.
