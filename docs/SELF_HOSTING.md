# Self-hosting BYOK Grid

The repository ships production-shaped images for the Next.js control plane and
Node.js workflow worker. The root Compose file is a **local evaluation
environment**, not a production topology. SQLite is the application source of
truth. PostgreSQL is present only as Hatchet's private scheduler store; its
credentials are public development values and the Hatchet image has
authentication disabled.

## Local container evaluation

Prerequisites are Docker Compose and a copied `.env.example` at `.env`.

1. Generate unique local values for `BYOK_GRID_MASTER_KEY` and
   `BETTER_AUTH_SECRET` as described in `.env.example`.
2. Run `npm run infra:up` to start local Hatchet and its private PostgreSQL
   dependency.
3. Open <http://localhost:8888>, create or copy the development worker token
   from **Settings → API Tokens**, and set `HATCHET_CLIENT_TOKEN` in `.env`.
4. Run `npm run self-host:up`.
5. Wait for `sqlite-migrate` to complete, then open
   <http://localhost:3000>. The web container's `/api/health` endpoint reports
   database readiness and also drives the image health check.

The `app` Compose profile builds a non-root standalone Next.js image and a
SQLite-only visual-workflow worker. A one-shot SQLite migration job, web
container, and workflow worker share only the `sqlite_data` volume. Hatchet's
private PostgreSQL volume is isolated from all BYOK Grid processes. Image
entrypoints validate required runtime variables and exit before startup when a
value is missing; profile-independent interpolation does not block
infrastructure-only bootstrapping.

Use `npm run self-host:down` to stop the profile. Named SQLite, Hatchet
PostgreSQL, and Hatchet configuration volumes are retained. Removing volumes is
a separate destructive operation and is intentionally not part of that script.

## Images

Build either runtime directly from the repository root:

```text
docker build --target web -t byok-grid-web .
docker build --target workflow-worker -t byok-grid-workflow-worker .
docker build --target migration -t byok-grid-migration .
docker build --target connector-runner -t byok-grid-connector-runner .
```

The Dockerfile uses a digest-pinned Node 24.14 image, the repository-declared
npm 11.17 installer, and `npm ci` against the committed lockfile. The web
runtime consumes Next.js standalone output instead of a complete monorepo
dependency tree. The worker deliberately retains the TypeScript workspace
sources and production `tsx` runtime because those package exports currently
point to source. The separately publishable connector SDK is compiled in an
explicit clean stage and shared by both builds; host-generated `dist` files are
excluded from the build context. Moving to a bundled worker is a future image-
size optimization that must preserve connector loading and source maps. The
workflow-worker target runs portable visual graphs and every background
integration from the shared SQLite store. It does receive the
deployment master key so credential-bearing nodes can decrypt secrets only at
execution time; Hatchet receives delivery and run identifiers, never those
secrets. When community connectors are enabled, the workflow worker also needs
the signed registry mount plus the connector-runner URL and shared RPC secret.
The runner remains isolated from SQLite and workspace encryption keys.
The same workflow-worker process schedules and executes SQLite-owned HTTP and
HubSpot sources. `SOURCE_SCHEDULER_POLL_SECONDS` controls the due-source scan
interval; source credentials and encrypted page cursors never enter Hatchet.

`NEXT_PUBLIC_APP_URL` is a public build argument because Next.js may embed
`NEXT_PUBLIC_*` values in browser assets. Database URLs, auth secrets, provider
keys, encryption keys, and Hatchet tokens are runtime values and must never be
passed as image build arguments.

## Production boundary

A production operator must supply infrastructure outside the local Compose
defaults:

- persistent local storage for the SQLite database and WAL on one active
  application/worker host, or a remote libSQL service for a supported
  multi-host topology;
- an authenticated, release-pinned Hatchet deployment or compatible managed
  Hatchet endpoint with TLS;
- unique `BETTER_AUTH_SECRET`, `BYOK_GRID_MASTER_KEY`, and
  `BYOK_GRID_MASTER_KEY_ID` values from a secret manager;
- HTTPS termination with the canonical public URL configured consistently;
- private-network egress denial, DNS controls, and provider allowlisting around
  the worker as defense in depth;
- centralized logs that redact cookies, invitation URLs, provider payloads,
  credentials, and workflow inputs; and
- SQLite online-backup (or `VACUUM INTO`), encryption-key, and restore
  procedures tested before accepting
  customer data.

Run SQLite migrations as a one-shot release job with `SQLITE_DATABASE_URL` and,
for remote libSQL, `SQLITE_AUTH_TOKEN`. The web container needs those values,
`BETTER_AUTH_SECRET`, and `BETTER_AUTH_URL`. The workflow worker needs the same
SQLite settings plus Hatchet client settings and BYOK encryption-key values.
No BYOK Grid runtime needs PostgreSQL credentials.

Set `AUTOMATIC_RUN_MAX_PER_ROW_CHANGE` and
`AUTOMATIC_WRITEBACK_MAX_PER_ROW_CHANGE` conservatively for the deployment.
The worker blocks an entire over-limit fan-out instead of letting column or
destination ordering decide which external effects occur.

## Optional community connector runner

Do not enable the runner until an administrator has verified the publisher-key
fingerprint through an independent channel, reviewed the registry, and verified
every artifact digest. The reference profile includes its public key and
detached signature. It can be evaluated by setting the four connector variables
documented in `.env.example`, generating a unique
`CONNECTOR_RUNNER_SHARED_SECRET`, and running:

```text
docker compose --profile app --profile sandbox-connectors up --build
```

The runner is attached only to an internal Compose network, has no database or
master-key environment, drops Linux capabilities, and uses a read-only root
filesystem. A production deployment should preserve those controls, mount its
registry and artifacts read-only, rotate the RPC secret through a secret
manager, and apply a network policy that permits RPC only from the worker. The
web, worker, and runner must use the same reviewed registry and compatible
Ed25519 trust maps. Keep publisher private JWKs outside the deployment and
repository, use a dual-signed registry during key rotation, and restart all
three processes after changing the registry or trust set. Unsigned registry
flags are development-only and must remain false in production. Workspace roles
do not grant artifact-installation rights. See
[`docs/COMMUNITY_CONNECTORS.md`](COMMUNITY_CONNECTORS.md) for signing commands
and rotation order.

The application exposes workspace-scoped online revocation for verified
publisher keys, connector IDs, versions, and artifact digests. It supplements
deployment controls; it does not change which registry signatures are trusted.
For a globally compromised publisher, remove the key from
`BYOK_GRID_CONNECTOR_TRUST_KEYS`, review or remove the registry, and restart the
web, worker, and runner. During planned dual-signature rotation, workspace
publisher revocation blocks execution only after every verified co-signer is
revoked; an artifact block is the immediate exact-code kill switch.

The image health check proves the Next.js server can open a fully migrated
SQLite database; it does
not prove Hatchet availability, provider reachability, or that background work
is draining. Production monitoring must cover queued-work age, workflow failure
rate, database saturation, and provider error/limit rates separately.

## Production Kubernetes

The vendor-neutral Helm chart in `deploy/helm/byok-grid` preserves the separate
web, worker, and migration identities and supports the optional runner and
analytics projector without bundling their external data services. See the
[`Kubernetes deployment guide`](KUBERNETES.md) for the Secret contract,
migration-hook ordering, secure pod defaults, validation commands, and rollout
procedure.

Airbyte and ClickHouse are not default image dependencies. Deploy them only
when an operator chooses the optional bulk-ingestion adapter or analytics
projection; neither is permitted to become the product database or credential
authority.

To evaluate the ClickHouse projection, set a unique `CLICKHOUSE_PASSWORD` and
run `docker compose --profile analytics up --build -d`. This profile is still a
local evaluation topology: production requires HTTPS, secret-managed
credentials, network isolation, retention, backups, and an independently
maintained ClickHouse deployment. See
[`docs/CLICKHOUSE_ANALYTICS.md`](CLICKHOUSE_ANALYTICS.md).

## Workspace deletion and retained copies

Owners can permanently purge a workspace after reviewing its affected record
counts and clearing active work. Deployment operators alone manage retention
holds. Optional ClickHouse rows are erased asynchronously after a minimum
one-hour drain period, while backup expiry and external BYOK provider copies
remain operator responsibilities. Before production use, publish those periods
and rehearse post-restore purge reconciliation. See the
[workspace deletion and retention guide](DATA_RETENTION.md).
