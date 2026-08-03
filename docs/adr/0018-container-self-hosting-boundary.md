# ADR 0018: Container self-hosting boundary

- Status: Accepted
- Date: 2026-08-01

## Context

BYOK Grid is intended to be genuinely self-hostable, but source-only setup left
operators to invent runtime images, migration ordering, user privileges, and
health checks. The existing Compose file intentionally uses fixed local
PostgreSQL credentials and an auth-disabled Hatchet development image, so
calling it production-ready would create a dangerous deployment trap.

The web and worker also have different packaging needs. Next.js can emit a
small standalone runtime, while internal worker packages currently export
TypeScript source and require a TypeScript runtime loader.

## Decision

The repository provides one multi-stage Dockerfile with independent `web`,
`worker`, and optional `connector-runner` targets:

- both use a digest-pinned Node 24 base, the repository-declared npm installer,
  lockfile installation, and the built-in unprivileged `node` user;
- the web target copies only Next.js standalone output and static assets;
- a clean intermediate stage compiles the publishable connector SDK so neither
  image depends on host-generated output;
- the worker target prunes development dependencies, retains only required
  workspace source, and declares `tsx` as a production dependency;
- target-specific entrypoints reject missing runtime configuration before an
  application or migration process starts;
- public Next.js configuration may be a build argument, but secrets and
  database URLs are runtime-only; and
- the web image health check calls the database-aware `/api/health` route.

The Rust/Wasmtime connector-runner target is a separate non-root runtime. Its
Compose profile is opt-in, mounts only an administrator-reviewed registry,
receives no database or master-key secret, drops Linux capabilities, and joins
an internal-only worker RPC network as specified in ADR 0022.

The existing Compose file gains an opt-in `app` profile. A one-shot migration
service must succeed before the web and worker start, and each runtime receives
its distinct local database role. The profile deliberately reuses the local
auth-disabled Hatchet image and therefore remains an evaluation path only.

Production deployment must use authenticated Hatchet, TLS, managed secrets,
backups, external egress controls, and separate least-privilege database
credentials. ADR 0032 adds a vendor-neutral Helm release while leaving each
stateful service under the operator's chosen infrastructure lifecycle.

## Airbyte and ClickHouse boundary

Neither Airbyte nor ClickHouse is built into the default application images or
default Compose graph. They remain independently enabled optional adapters:
Airbyte for selected bulk ingestion and a separate projector plus ClickHouse
profile for rebuildable analytics.

## Consequences

- Contributors and evaluators can exercise the same image entrypoints a
  deployment would run without installing Node.js on the host.
- The local stack validates migration ordering and role separation while being
  clearly labeled unsafe for production exposure.
- The worker image is larger than a single-file bundle. Bundling can be adopted
  later after its connector-loading and source-map contract is tested.
- The Kubernetes chart remains an application release rather than a bundled
  database or workflow-platform installer.
