# ADR 0026: Bounded conditional filter trees

## Status

Accepted.

## Context

Flat `AND` filters cannot express common qualification policies such as
"verified enterprise accounts or high-scoring inbound leads." Implementing
separate condition formats for the grid, exports, bulk enrichment, and future
automations would let the same visible rule select different records or
authorize different provider spend.

A recursively authored condition language also creates denial-of-service and
query-safety risks if depth, width, operators, or authored values are not
bounded before SQL compilation.

## Decision

The shared domain package owns one canonical filter AST. Every group has an
explicit `and` or `or` combinator and contains typed leaf predicates or nested
groups. The root may be empty to mean "all rows"; nested empty groups are
invalid because their boolean meaning is surprising in an editor.

The policy permits at most 12 leaf predicates in total, three group levels,
and eight direct children per group. Leaves retain the saved-view typed
operator allowlist and immutable column IDs. Database services recursively
validate every referenced column and compile the AST using fixed Drizzle
branches. Authored comparison values are always bound parameters; neither a
combinator nor a value can inject a SQL fragment.

Grid reads, CSV export, view-scoped bulk preview and confirmation, and schema
dependency checks consume the same tree. Bulk-run history freezes the
canonical tree with the exact ordered row-ID digest so later view edits cannot
change already authorized work.

The previous public request shape and stored saved views used a flat array of
at most five filters. API parsing still accepts that shape and normalizes it to
a root `AND` group. Migration 0027 upgrades persisted saved views in place.
Legacy immutable bulk snapshots remain readable through the same normalization
path rather than rewriting audit history.

## Consequences

- Common qualification and exclusion alternatives are expressible without
  arbitrary SQL or executable workspace code.
- The same versioned policy language now powers conditional HubSpot writeback
  through ADR 0027. Conditional enrichment still requires a separate spend and
  dependency policy before automatic execution.
- The explicit limits constrain validation work, editor complexity, SQL size,
  and pathological query planning.
- Increasing a limit or adding an operator is a query-language and security
  change requiring policy, compiler, migration-compatibility, dependency, grid,
  export, and exact bulk-selection tests.
