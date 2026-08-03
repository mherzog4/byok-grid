# ADR 0022: Capability-constrained community connectors

- Status: Accepted
- Date: 2026-08-01

## Context

An open-source enrichment platform needs an extension path that does not make
every deployment trust arbitrary npm packages inside the database-connected
worker. Community connectors still need workspace-owned credentials and HTTP
access, but handing a plugin the worker process would also hand it environment
variables, the filesystem, the master key, database access, and unrestricted
networking.

A remote webhook protocol would isolate code operationally, but would send
workspace data and credentials to another service and weaken the BYOK/self-host
boundary. A JavaScript isolate would share more of the Node runtime and has a
larger ambient-capability surface. A separate WebAssembly process gives us a
small, language-neutral ABI and an independently constrained deployment unit.

## Decision

Built-in TypeScript connectors remain reviewed, trusted, and in-process.
Administrator-installed community connectors use sandbox protocol 1.0 and run
in the optional Rust/Wasmtime sidecar. A deployment registry pairs a complete
protocol 1.1 manifest with an artifact path and lowercase SHA-256 digest. The
control plane rejects built-in ID collisions, duplicate ID/version pairs, and
runtime host policies. Each column and queued cell run stores the connector
semantic version so a registry update cannot reinterpret queued work.

The sidecar accepts only core WebAssembly modules with these exports:

- `memory`;
- `alloc(input_length: i32) -> input_pointer: i32`; and
- `execute(input_pointer: i32, input_length: i32) -> packed_output: i64`, where
  the high 32 bits contain the output pointer and the low 32 bits contain the
  output byte length.

Modules with any import are rejected before installation. The guest therefore
has no WASI environment, filesystem, clock, randomness, socket, DNS, logging,
database, or host-function capability. Every invocation receives a fresh store
with a 16 MiB default linear-memory ceiling, one instance/memory/table, a
10-million fuel budget, and one MiB input/output bounds. Fuel deterministically
interrupts non-terminating computation. The runner verifies the publisher-signed
registry and artifact digest on startup and authenticates worker RPC bodies with
an exact-body HMAC-SHA256 and a 60-second replay window. Publisher trust and
rotation are specified separately in ADR 0029.

## Declarative HTTP effects

The guest cannot open a socket. It may instead return an `http_request` step
containing an HTTPS request and JSON continuation state. The Node worker checks
the request against the action's fixed host list, forbids user-info and
nonstandard ports, removes hop-by-hop/proxy headers, disables redirects, limits
headers and bodies, and performs the request through the existing DNS-pinned
private-network-denying dispatcher. The bounded response is base64-encoded and
returned to the next guest invocation. A default four-effect budget prevents
one cell from amplifying into an unbounded number of provider calls.

Workspace credentials remain envelope-encrypted in PostgreSQL and are decrypted
just in time by the worker. Only the action credential object enters the guest
invocation; the runner container receives neither the deployment master key nor
a database connection. Community credential forms are bounded, declarative
registry metadata. They may contain up to sixteen reviewed text/password fields
whose keys and required flags must exactly match a closed object credential
schema. No community HTML, React, or browser JavaScript enters the trusted
control plane.

Credential, action-input, and action-output JSON Schemas are compiled with
strict draft-2020-12 Ajv at registry load. Remote references, asynchronous
validation, mutation/coercion, and oversized or deeply nested schemas are
rejected. The control plane validates credentials before encryption; the worker
validates input before RPC and completed output before persistence.

## Deployment and installation

The runner is excluded from the default stack. Compose exposes it through the
`sandbox-connectors` profile on an internal-only network, drops Linux
capabilities, uses a read-only root filesystem and an unprivileged numeric user,
and mounts the reviewed registry read-only. The worker and runner share only a
deployment-generated RPC secret. Registry changes are an administrator action
and require a process restart; workspace users can select installed manifests
but cannot install artifact bytes.

The repository's WAT reference connector proves the ABI, digest check, manifest
catalog path, and no-import policy. It is deliberately simple and is not a
template for hand-authoring production connectors; language SDK/tooling can
compile to the same ABI later.

## Airbyte and ClickHouse boundary

This sidecar is the low-latency per-cell extension boundary. Airbyte remains an
optional, user-owned bulk ingestion bridge and must not execute cell connectors
or receive the grid's master key. ClickHouse remains an optional rebuildable
analytics projection and must not authorize runs, store authoritative cells, or
participate in credential resolution.

## Consequences

- Community connector features are limited to pure computation and a bounded
  declarative HTTPS effect loop; richer capabilities require a protocol and ADR
  revision.
- Artifact identity is digest-pinned and registry approval is bound to a trusted
  Ed25519 publisher. ADR 0031 adds workspace-visible provenance and online
  publisher/connector/version/artifact revocation without a marketplace.
  Deployment-wide revocation distribution and a public transparency log remain
  future optional layers.
- JSON Schema is an enforced host contract. Schemas remain
  administrator-trusted configuration because pathological regular expressions
  can still consume CPU; artifact installation and schema review are the same
  privileged decision.
- Fuel bounds computation but is not a real-time SLA. The worker separately
  bounds runner RPC and provider HTTP duration.
- Keeping the sidecar optional preserves a small default Next.js/PostgreSQL/
  Hatchet installation while giving security-conscious operators a credible
  extension path.
