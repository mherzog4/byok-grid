# ADR 0035: Make SQLite the default application database

- Status: accepted
- Date: 2026-08-02

## Context

BYOK Grid is an open-source, self-hostable data-enrichment and workflow product.
Its first implementation used PostgreSQL for application state, tenant row-level
security, concurrent job claiming, advisory locks, and trigram-backed table
search. That is a strong scale-out design, but it makes the smallest useful
self-hosted installation operate a database service before a user can create a
table or workflow.

The product should start with one application process and one durable data file.
Its connector credentials, table data, saved views, workflow definitions, run
state, and audit records must remain portable and inspectable. Airbyte, Hatchet,
and ClickHouse are integrations with their own storage requirements; they must
not dictate the application store.

## Decision

SQLite is the default and authoritative application database. The Node.js
process uses Drizzle's SQLite dialect with `@libsql/client` and a local `file:`
URL. A remote, self-hosted `libsql://` endpoint is an optional deployment mode.
It is not required by the default installation.

Every connection enables foreign keys and a five-second busy timeout. Local
files use WAL journal mode and `synchronous=NORMAL`. Deployments must place the
database and its WAL files on persistent, low-latency storage. A network file
system shared by independent application replicas is unsupported.

SQLite does not provide PostgreSQL row-level security. Every user-facing data
operation must therefore begin from an authenticated workspace scope and join
through `workspace_members`; identifier-only lookups are forbidden. These
guards are tested with cross-workspace fixtures. Worker entry points use a
separate capability-oriented API and never accept an arbitrary user scope.

PostgreSQL advisory locks and `FOR UPDATE SKIP LOCKED` become short write
transactions with conditional updates. A claimant changes a row from its
expected state to a leased state only when the expected version/status and
lease deadline still match. The affected-row count decides ownership. Work
remains idempotent because durable operation keys and unique constraints are
authoritative.

Table-wide search uses a contentless FTS5 index maintained by triggers. The
canonical per-cell text remains bounded to the first 8,192 characters. Search,
saved-view filters, keyset cursors, CSV exports, and frozen bulk/workflow
selections continue to describe the same row universe.

Dates are stored as integer Unix milliseconds and mapped to `Date` values.
Booleans are constrained integers. UUIDs and enum values are constrained text.
JSON values and UUID arrays are canonical JSON text validated in the domain
layer and, where practical, with SQLite JSON functions.

## Deployment envelope

The embedded profile supports one active application/worker host with many
readers and a serialized writer. It is the default for local use and modest
self-hosted teams. Multi-host active/active deployments must use a remote
libSQL service that supplies its own consistency contract, or a future
PostgreSQL storage adapter. ClickHouse remains optional for analytical
projections and is never authoritative for interactive grids or workflows.

## Cutover status

All shipped web routes, the Node workflow worker, the migration image, and the
optional ClickHouse projector now use the SQLite adapter. The package's default
export is SQLite-only, which prevents the production dependency graph from
loading a PostgreSQL driver. The SQLite suite covers schema constraints, tenant
isolation, lease claims, cancellation, idempotency, lifecycle operations, and a
clean installation.

The earlier PostgreSQL implementation and its opt-in tests remain as historical
compatibility material under the explicit `@byok-grid/db/postgres` export. It is
not deployed by Compose or Helm and its migrations are never replayed against
SQLite. A future supported import tool must verify row counts, identifiers,
digests, timestamps, and encrypted credential bytes before claiming an
in-place PostgreSQL-to-SQLite migration path.

## Consequences

- A new contributor can run the application with a writable directory and no
  application PostgreSQL server.
- Backups require the SQLite online-backup API or `VACUUM INTO`; copying only
  the main file while WAL writes are active is unsafe.
- Long write transactions reduce concurrency and are prohibited. Network and
  provider calls occur outside transactions.
- Authorization moves from a database backstop into a small, mandatory query
  boundary, increasing the importance of adversarial tenant-isolation tests.
- FTS5 availability is a startup prerequisite and is checked before migrations.
- Hatchet may still use PostgreSQL in its own service profile until its durable
  execution role is replaced; that database is not BYOK Grid application data.
