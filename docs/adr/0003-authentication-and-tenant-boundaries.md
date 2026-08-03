# ADR 0003: Database-backed authentication and tenant boundaries

- Status: Accepted
- Date: 2026-07-31

## Context

The control plane needs self-hostable authentication without delegating core
identity to a proprietary service. Every grid mutation must remain scoped to a
workspace even if a route handler receives valid IDs from another tenant.

## Decision

Use Better Auth with its Drizzle adapter and PostgreSQL-backed users, accounts,
sessions, verification records, and rate limits. IDs are UUIDs across auth and
domain tables. Telemetry is disabled by default.

Workspace membership is explicit. Composite foreign keys ensure rows, columns,
cells, credentials, and runs cannot be combined across workspaces or tables.
Application services also join through membership before reading or mutating
grid data. Inaccessible resources return a generic not-found response.

Cell edits use optimistic concurrency. Clients send the version they observed;
the database increments that version only when it still matches. Stale edits
receive a conflict and must reload or explicitly reconcile.

## Consequences

- Identity and product data can be backed up and self-hosted together while
  retaining separate table ownership.
- Horizontal web replicas share sessions and rate-limit state.
- Email delivery and verified-email enforcement remain deployment concerns and
  must be configured before public signup is enabled in production.
- PostgreSQL row-level security now provides a second enforcement layer as
  specified by ADR 0007; composite scope constraints and membership joins
  remain mandatory for structural integrity and clear application errors.
- Account deletion stays disabled until sole-owner and collaborative workspace
  transfer behavior is specified.
