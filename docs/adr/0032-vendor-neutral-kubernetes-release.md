# ADR 0032: Vendor-neutral Kubernetes release boundary

- Status: Accepted
- Date: 2026-08-01
- Amended: 2026-08-03 by ADR 0035's SQLite-first authority decision

## Context

Compose proves local image integration but does not define a safe production
rollout, secret boundary, or migration lifecycle. Self-hosters otherwise need
to invent those decisions independently, which is especially risky because the
web, worker, migration, and optional projector must share one authoritative
remote libSQL database without sharing unrelated runtime secrets.

Bundling libSQL, Hatchet, Airbyte, or ClickHouse into one application chart
would appear convenient but would force backup, upgrade, security, and scaling
opinions on every operator. It would also blur the distinction between the
authoritative product database and optional ingestion or analytics adapters.

## Decision

The repository publishes a Helm application chart with independently built
web, worker, and migration images. A remote libSQL service and authenticated
Hatchet remain external required services for the multi-pod topology. The
community connector runner and ClickHouse projector are opt-in workloads
against operator-provisioned storage/services. Airbyte remains a separately
operated destination image and is not a chart dependency.

The release preserves these boundaries:

- a `pre-install,pre-upgrade` migration Job applies schema changes before
  runtime rollout, mounts no Kubernetes API token, and can use an
  operator-precreated ServiceAccount when necessary;
- the migration hook, web, worker, and optional projector use the same remote
  SQLite/libSQL authority, while each receives only its component-specific
  non-database secrets;
- an existing Secret is the default, because Helm release values are not a
  production secret store;
- workloads run non-root with read-only filesystems, dropped capabilities,
  disabled token mounts, and runtime-default seccomp;
- database-aware readiness and process-only liveness are separate;
- chart schema and deterministic minimal/full renders are checked in CI; and
- chart image values accept a tag or an immutable digest, never both, and each
  release publishes a generated values file containing its attested digests.

The optional runner mounts a reviewed artifact PVC read-only. A NetworkPolicy
allows worker RPC ingress and no runner egress. Broader provider egress policy
remains operator-owned because portable Kubernetes policies cannot express the
deployment's changing FQDN allowlist.

## Consequences

- Operators can deploy to any conforming Kubernetes distribution without
  adopting a particular cloud database, secret manager, ingress, or CNI.
- Operators retain responsibility for libSQL, Hatchet, TLS, DNS, backups,
  secret synchronization, and CNI-specific provider egress.
- External Secret changes do not alter the pod template checksum; a reloader or
  explicit rollout is required after rotation.
- The web image contains no operator origin; the chart supplies Better Auth's
  canonical public URL at runtime so one attested digest remains portable.
- A successful pre-upgrade migration survives Helm rollback. Schema evolution
  must therefore be backward-compatible and use expand/contract releases.
- The chart creates no Airbyte or ClickHouse server. Their failures cannot
  block core grid reads/writes, authentication, or authorization.
