# ADR 0048: Kubernetes remote database mode

- Status: accepted
- Date: 2026-08-03

## Context

The reference Helm deployment runs multiple stateless web pods and may run
multiple workflow-worker or analytics-projector pods. They must share one
authoritative SQLite-compatible database through remote libSQL. A Kubernetes
Secret is resolved only by the kubelet, so Helm cannot inspect an externally
managed `sqlite-database-url` value during linting or rendering.

The application runtimes still accepted `file:` URLs for local development. A
misconfigured external Secret could therefore give each pod its own local
database. Individual health checks could succeed while requests observed
different users, workspaces, and workflow state depending on pod routing.

## Decision

Database configuration has an explicit `local` or `remote` mode. Local mode is
the default and continues to accept `file:`, `:memory:`, and `libsql://` URLs.
Remote mode accepts only `libsql://`.

The Helm chart sets `BYOK_GRID_DATABASE_MODE=remote` directly on every
database-owning workload: web, workflow worker, migration Job, and optional
analytics projector. Each process validates the mode against the actual URL
resolved from its Secret before creating a directory, opening the database,
serving requests, registering work, applying migrations, or projecting events.
Errors identify the invalid fields and required scheme without echoing the URL
or authentication token.

## Consequences

- An external Secret containing `file:` or `:memory:` cannot silently create
  isolated pod-local application state in the reference deployment.
- Local contributors retain the file-backed SQLite workflow without needing a
  remote service or an additional environment variable.
- The mode is a deployment safety assertion, not automatic provider discovery.
  A non-Kubernetes operator using multiple processes must also select `remote`.
- This contract does not prove remote libSQL durability, consistency, backup,
  restore, or failover. Those remain provider-specific release gates.

## Verification

The shared database configuration tests prove local default behavior, accepted
remote libSQL, exact error paths, and secret-safe rejection of remote mode with
a file URL. Web and analytics configuration tests prove their startup paths
consume the policy. The migration CLI child-process test selects remote mode
with a unique temporary file path, requires the `libsql://` configuration
error, verifies the URL is not disclosed, and verifies no file was created.
Type checking proves the workflow worker passes its parsed mode into the shared
database opener.

`npm run helm:verify` requires three remote-mode injections in the default
render and four when the optional projector is enabled, covering every
database-owning chart workload.
