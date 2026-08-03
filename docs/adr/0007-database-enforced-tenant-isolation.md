# ADR 0007: Database-enforced tenant isolation

- Status: Accepted
- Date: 2026-07-31

## Context

Workspace IDs in every service query and composite foreign keys prevent many
cross-tenant mistakes, but they do not independently stop a new query that
forgets its membership predicate. PostgreSQL connection pooling also makes a
session-scoped identity variable unsafe: the next request can receive the same
connection.

The worker deliberately processes jobs from every workspace, while the web
application must only act for one authenticated user. A single database role
cannot express both trust levels honestly.

## Decision

Use three product-database connections:

- `MIGRATION_DATABASE_URL` owns schema changes and may administer policies;
- `DATABASE_URL` is a `NOSUPERUSER NOBYPASSRLS` web role; and
- `WORKER_DATABASE_URL` is a non-superuser worker role with `BYPASSRLS`.

All tenant-owned tables enable and force RLS. Web code enters
`withUserDatabase(userId, callback)`, which opens a transaction and calls
`set_config('byok_grid.user_id', userId, true)` on the same connection. The
third argument makes the setting local to that transaction, so commit and
rollback both clear it before the connection returns to the pool. A query made
through the web role without this wrapper sees no tenant rows.

Security-definer policy helpers have a fixed search path and perform only
static membership lookups. Ordinary data tables allow workspace members;
credential key material and membership administration have narrower
owner/administrator policies that mirror the shared domain policy.

Invitation acceptance is the one legitimate operation performed before
membership exists. The service stores the presented token's domain-separated
hash in a second transaction-local setting. RLS exposes only the matching,
unexpired invitation for the signed-in email. Acceptance first records the
invitation transition, then permits insertion of only the exact user,
workspace, and role named by that accepted invitation. Immutable-scope and
single-use lifecycle guards prevent retargeting the row.

## Trust boundary

This design catches omitted workspace predicates and constrains application
bugs that still use the normal database wrapper. It does not make the shared
web database password an untrusted credential: anyone holding it can set a
custom PostgreSQL identity variable. A web database credential leak therefore
remains a full product-data incident.

The worker bypass is similarly intentional and high impact. It belongs only in
the worker process, whose connector egress and secret-handling boundaries are
documented separately. Neither privileged URL may be available to client code,
preview logs, or a public deployment environment.

## Verification

CI creates real restricted and bypass roles before applying migrations. The
RLS integration test proves that:

- two authenticated owners see only their own workspaces;
- a cross-workspace write is rejected even without an application predicate;
- invitation acceptance can create only the authorized membership;
- a member cannot perform an owner mutation;
- transaction-local identity is cleared after commit; and
- the worker role can intentionally scan multiple workspaces without identity.

## Consequences

- Every new tenant table needs a policy in the same migration as the table.
- Every web tenant call must use the scoped database helper, including each
  page or batch of a streaming route.
- Local and production deployments must create the three roles before applying
  migrations. The bundled initializer does this only for a fresh local volume.
- Direct integration tests may use the migration connection for fixture setup,
  but isolation tests must exercise the restricted web role.
