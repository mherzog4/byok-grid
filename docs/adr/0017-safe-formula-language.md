# ADR 0017: Safe formula language authoring

- Status: Accepted
- Date: 2026-08-01

## Context

The formula evaluator already executes a bounded, typed expression tree with
stable column IDs, explicit dependencies, cycle detection, and atomic
recomputation. The original Next.js form exposed only five fixed templates,
which prevented users from authoring the nested arithmetic, conditions, and
fallbacks already supported by the runtime.

Accepting JavaScript, SQL, or dynamically evaluated expressions would weaken
self-hosting safety. It would require a sandbox, resource accounting, a much
larger language surface, and a new data-access capability model.

## Decision

BYOK Grid exposes a small spreadsheet-like formula language that compiles to
the existing `FormulaExpression` union. It supports:

- stable column references written as `[Column name]`, with `]]` escaping a
  closing bracket inside a name;
- JSON-escaped double-quoted text, finite numbers, `TRUE`, `FALSE`, and
  `EMPTY` literals;
- `TIMESTAMP("…")` literals with an explicit UTC or numeric offset and
  `JSON("…")` literals containing valid JSON;
- nested `CONCAT`, `COALESCE`, `IF`, `EQUALS`, `ADD`, `SUBTRACT`, `MULTIPLY`,
  `DIVIDE`, `LOWER`, `UPPER`, and `TRIM` calls.

Column names are resolved once, inside the authenticated database service, and
compiled to immutable column IDs. An exact name wins. Otherwise, Unicode-
normalized case-insensitive matching is allowed only when it finds exactly one
column. Renaming a display label later cannot retarget a stored formula.

The browser performs the same parse and type inference for immediate feedback,
but the API and tenant-scoped database service parse and validate again. Formula
source is limited to 16,384 characters; compiled trees remain limited to 12
levels and 128 nodes. A formula must reference at least one accessible source
column. The service stores only the versioned AST and dependency edges, never
executable source code.

The guided template form remains available for simple operations. The formula
language is the expressive authoring surface for nested expressions.

## Airbyte and ClickHouse boundary

Airbyte imports may populate source columns, and ClickHouse may project formula
results or timing metrics, but neither parses or executes formula definitions.
PostgreSQL owns the expression configuration, dependency graph, and current
cell value.

## Consequences

- Users can author the complete existing formula function set without adding
  arbitrary code execution.
- Formula meaning survives display-name changes because stored references use
  IDs.
- Deterministic timestamp literals require an offset even though interactive
  input cells continue to interpret native date-time controls in browser-local
  time.
- Editing, version history, additional functions, infix operators, and
  localization remain future language extensions.
