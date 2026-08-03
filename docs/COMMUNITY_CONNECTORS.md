# Community connector authoring

Community connectors are administrator-installed WebAssembly modules. They are
not npm packages and are never imported into the Next.js or worker process. Read
[ADR 0022](adr/0022-capability-constrained-community-connectors.md) before
authoring or installing one.

## Registry contract

Set `BYOK_GRID_CONNECTOR_REGISTRY_PATH` to an administrator-owned JSON file. A
registry entry binds four things:

- `artifact.path`: a path relative to the registry directory;
- `artifact.sha256`: the reviewed lowercase SHA-256 digest;
- `manifest`: protocol 1.1 catalog, action, host, input, output, and credential
  metadata; and
- `credentialForm`: a declarative form or `null` when no credential is needed.

`catalog: true` exposes one version of a connector to new columns. Older
versions may remain installed with `catalog: false` so already-queued and
existing columns continue to resolve their pinned semantic version. Registry
changes require restarting the web, worker, and runner processes.

## Publisher signatures

Every filesystem-backed registry is authenticated before it is parsed. The
default detached file is `<registry-path>.sig.json`; it contains one or more
Ed25519 signatures over these exact bytes:

```text
BYOK_GRID_CONNECTOR_REGISTRY_V1\0 || registry file bytes
```

The domain prefix prevents a registry signature from being valid for another
protocol. Signing exact bytes means formatting changes require a new signature.
Both Node control-plane processes and the Rust runner verify independently.

Generate a publisher key and public trust map without printing private key
material:

```text
npm run connector:keygen -- acme_connectors_2026 \
  ./private-publisher.jwk.json ./publisher-trust.json
```

The command creates new files only, writes the private JWK with mode `0600`,
and refuses to overwrite an existing key. Keep that JWK outside the repository
in a secret manager or offline signing environment. Sign the exact registry:

```text
npm run connector:sign-registry -- acme_connectors_2026 \
  ./private-publisher.jwk.json ./registry.json
```

The signer creates or updates `registry.json.sig.json` and preserves signatures
from other key IDs. Configure the public JSON map in both
`BYOK_GRID_CONNECTOR_TRUST_KEYS` and `CONNECTOR_RUNNER_TRUST_KEYS`. A signature
from at least one configured key is required. Optional
`BYOK_GRID_CONNECTOR_REGISTRY_SIGNATURE_PATH` and
`CONNECTOR_RUNNER_REGISTRY_SIGNATURE_PATH` values can move the detached file.

For key rotation, add the new public key to both trust maps, sign the same
registry with both old and new private keys, restart all processes, and remove
the old trust key only after every process trusts and verifies the new one.
The detached format supports up to 32 distinct signatures.

Unsigned registries fail closed. Local connector development can explicitly set
both `BYOK_GRID_ALLOW_UNSIGNED_CONNECTOR_REGISTRY=true` and
`CONNECTOR_RUNNER_ALLOW_UNSIGNED_REGISTRY=true` while leaving both trust maps
empty. Never use that mode with third-party artifacts or in production. If any
trust key is configured, a valid signature is still required even when an
unsigned-development flag is accidentally left on.

The reference installation is in
[`examples/connectors/reference`](../examples/connectors/reference). The Node
control plane validates the complete registry; the Rust runner independently
verifies its publisher signature and checks artifact path confinement, digest,
module imports, and ID/version shape.

## Transparency and emergency revocation

Workspace owners and administrators can inspect installed community versions in
the application. The inventory shows the artifact and exact registry SHA-256
digests, verified publisher key IDs, catalog status, actions, and fixed egress
hosts. These are provenance values, not a claim that a connector is safe.

An emergency block may target one publisher, connector ID, connector version,
or exact artifact digest. It is enforced before new work is queued and again by
the worker before execution, so queued runs are covered. During dual-signed key
rotation, publisher approval remains valid while at least one verified signer
is not revoked; use an artifact or version block when immediate exact denial is
required. Lifting a block retains the original incident record and actor.

Community columns created before provenance pinning have no artifact digest and
must be recreated. Do not "repair" them by copying the currently installed
digest into old run records: that would falsely claim historical approval.

## Declarative credentials

A credential form contains 1–16 fields:

```json
{
  "credentialForm": {
    "fields": [
      {
        "description": "Workspace-owned provider API key.",
        "key": "api_key",
        "label": "API key",
        "placeholder": "provider_…",
        "required": true,
        "secret": true
      },
      {
        "description": "Provider account identifier.",
        "key": "account_id",
        "label": "Account ID",
        "required": true,
        "secret": false
      }
    ]
  }
}
```

Every form key must appear exactly once in a closed object
`manifest.credentialSchema`; its `required` flag must agree with the JSON Schema
`required` array. A secret field renders as a password input, while a non-secret
field renders as text. Both are encrypted together in the workspace vault and
are never displayed again. Community HTML, React components, scripts, and
custom field types are not accepted.

## JSON Schema policy

Credential, action-input, and action-output schemas use JSON Schema draft
2020-12 and are compiled by pinned Ajv 8 in strict mode when the registry is
loaded. The validator does not coerce values, apply defaults, remove properties,
or load remote references. Asynchronous schemas are rejected.

Each schema is limited to 64 KiB, 32 levels, and 2,048 traversed nodes. Prefer
closed objects with explicit `properties`, `required`, and
`additionalProperties: false`. Inputs and credentials are validated before RPC;
completed outputs are validated before they enter run history or a visible grid
cell. Validation errors expose a generic message so schemas cannot cause secret
values to enter logs or API responses.

## Guest ABI and effects

The core-Wasm module exports `memory`, `alloc(i32) -> i32`, and
`execute(i32, i32) -> i64`. `execute` returns the output pointer in the high 32
bits and length in the low 32 bits. The JSON input and output envelopes are
defined by sandbox protocol 1.0 in `@byok-grid/connector-sdk`.

The module must import nothing. To call a provider, return an `http_request`
step whose HTTPS hostname appears in that action's fixed host policy. The worker
performs the request through DNS-pinned egress, then reinvokes the guest with a
bounded response and the guest's JSON continuation state. The default action
budget is four HTTP effects.

## Review checklist

- Rebuild the artifact from reviewed source and compare its SHA-256 digest.
- Verify the publisher key fingerprint through a channel independent of the
  registry download.
- Confirm every action needs only its declared fixed provider hosts.
- Inspect credential and action schemas for tight size and shape constraints.
- Confirm retryable failures and ambiguous provider timeouts are documented.
- Retain old artifact versions while existing columns or queued runs reference
  them.
- Test with the runner's read-only, capability-dropped container profile.
- Do not put provider secrets in manifest defaults, action inputs, URLs, logs,
  source maps, or example fixtures.
