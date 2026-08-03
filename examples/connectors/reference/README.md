# Sandbox reference connector

This directory contains the smallest installable community connector. It proves
the publisher-signed registry, digest-pinned no-import WebAssembly ABI, and
returns `wasmtime` as a visible text cell. It does not make an HTTP request or
use a credential.

1. Review `registry.json`, `registry.json.sig.json`, the public key in
   `.env.example`, and independently verify the SHA-256 digest of `reference.wat`.
2. Generate `CONNECTOR_RUNNER_SHARED_SECRET` with `openssl rand -base64 32`.
3. Set `BYOK_GRID_CONNECTOR_REGISTRY_PATH=/connectors/registry.json`,
   `CONNECTOR_REGISTRY_HOST_PATH=./examples/connectors/reference`, and
   `CONNECTOR_RUNNER_URL=http://connector-runner:4319` in `.env`.
4. Start the app and runner with
   `docker compose --profile app --profile sandbox-connectors up --build`.

The runner accepts no module imports. A production connector returns a
versioned `complete`, `failure`, or declarative `http_request` step using the
ABI documented in
[`ADR 0022`](../../../docs/adr/0022-capability-constrained-community-connectors.md).
Use the signing and publisher-key rotation workflow in
[`COMMUNITY_CONNECTORS.md`](../../../docs/COMMUNITY_CONNECTORS.md) for a custom
registry; never reuse the reference publisher identity for your artifacts.

The private key for `byok_grid_reference_2026` was retired after signing this
snapshot and is not stored in the repository or deployment. Any change to the
reference registry must use a new key ID and update the detached signature,
tests, `.env.example`, and Compose default trust maps together.
