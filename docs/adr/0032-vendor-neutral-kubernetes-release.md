# ADR 0032: Vendor-neutral Kubernetes release boundary

- Status: Accepted
- Date: 2026-08-01

## Context

Compose proves local image integration but does not define a safe production
rollout, secret boundary, or migration lifecycle. Self-hosters otherwise need
to invent those decisions independently, which is especially risky because the
web, worker, and migration processes intentionally use different PostgreSQL
privileges.

Bundling PostgreSQL, Hatchet, Airbyte, or ClickHouse into one application chart
would appear convenient but would force backup, upgrade, security, and scaling
opinions on every operator. It would also blur the distinction between the
authoritative product database and optional ingestion or analytics adapters.

## Decision

The repository publishes a Helm application chart with independently tagged
web, worker, and migration images. PostgreSQL and authenticated Hatchet remain
external required services. The community connector runner and ClickHouse
projector are opt-in workloads against operator-provisioned storage/services.
Airbyte remains a separately operated destination image and is not a chart
dependency.

The release preserves these boundaries:

- a `pre-install,pre-upgrade` migration Job applies schema changes before
  runtime rollout, mounts no Kubernetes API token, and can use an
  operator-precreated ServiceAccount when necessary;
- only the migration hook receives the schema-owner URL;
- web receives the forced-RLS URL, while worker/projector receive the explicit
  worker URL;
- an existing Secret is the default, because Helm release values are not a
  production secret store;
- workloads run non-root with read-only filesystems, dropped capabilities,
  disabled token mounts, and runtime-default seccomp;
- database-aware readiness and process-only liveness are separate; and
- chart schema and deterministic minimal/full renders are checked in CI.

The optional runner mounts a reviewed artifact PVC read-only. A NetworkPolicy
allows worker RPC ingress and no runner egress. Broader provider egress policy
remains operator-owned because portable Kubernetes policies cannot express the
deployment's changing FQDN allowlist.

## Consequences

- Operators can deploy to any conforming Kubernetes distribution without
  adopting a particular cloud database, secret manager, ingress, or CNI.
- Operators retain responsibility for PostgreSQL, Hatchet, TLS, DNS, backups,
  secret synchronization, and CNI-specific provider egress.
- External Secret changes do not alter the pod template checksum; a reloader or
  explicit rollout is required after rotation.
- `NEXT_PUBLIC_APP_URL` must be fixed when the web image is built and match the
  chart's canonical public URL.
- A successful pre-upgrade migration survives Helm rollback. Schema evolution
  must therefore be backward-compatible and use expand/contract releases.
- The chart creates no Airbyte or ClickHouse server. Their failures cannot
  block core grid reads/writes, authentication, or authorization.
