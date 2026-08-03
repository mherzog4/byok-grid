# ADR 0005: Versioned in-process connector protocol

- Status: Accepted
- Date: 2026-07-31

## Context

A Clay-like enrichment product needs a broad connector catalog without giving
provider code access to the control-plane database, workspace encryption keys,
or unrestricted networking. Connector authors also need a reusable contract
that is not legally coupled to the AGPL application.

Free-form HTTP is useful as an escape hatch, but it cannot describe a provider
action, generate a safe configuration form, validate structured output, or
pin an integration to provider-owned hosts. Adding every provider directly to
the worker would make the execution boundary implicit and difficult to extend.

## Decision

`@byok-grid/connector-sdk` is an Apache-2.0 workspace package and protocol. A
connector definition declares:

- a stable connector ID, semantic connector version, and protocol version;
- strict Zod credential, action-input, and action-output schemas;
- serializable catalog metadata and JSON Schemas;
- user-facing column input bindings;
- either a fixed provider-host policy or an explicit runtime host policy; and
- trusted executable action code that receives only bounded runtime
  capabilities.

The manifest is serializable and contains no executable functions or secret
values. The Next.js control plane uses manifests to validate and render the
connector catalog. The worker uses the corresponding trusted definition to
execute an action.

Protocol 1.1 lets each input field declare either a row-varying column binding
or a column-wide JSON literal. Column configurations store connector and action
IDs, protocol version, credential ID, and both binding kinds. Queuing a cell
freezes the resolved values into a durable run and writes the outbox event
atomically. It never copies decrypted credentials into the run or workflow
payload. The worker loads and decrypts the credential just before execution
and derives fixed allowed hosts from the installed action rather than the
database record.

Each action also declares a typed cell-output projection. The worker retains
the validated full provider output in `cell_runs.output`, then extracts only
the declared boolean, JSON, number, or text value into the visible sparse cell.
This keeps provider provenance available without leaking provider-specific
response envelopes into ordinary grid formulas and exports.

The initial provider adapters are Hunter Domain Search and OpenAI Responses.
Hunter maps a domain column and can reach only `api.hunter.io`. OpenAI maps a
prompt column plus literal model, instructions, and output-token settings, and
can reach only `api.openai.com`. Provider keys are added only inside the worker
request; they are never persisted in a run or logged. The generic HTTP
connector remains available with its separately persisted runtime allowlist.

## Extension boundary

Reviewed built-ins use trusted, in-process TypeScript. Community modules use the
separate, digest-pinned Wasmtime process and declarative HTTP-effect protocol
specified in ADR 0022. Publishing a package never installs code automatically;
installation remains an explicit deployment-administrator action. Publisher
signatures, revocation, and marketplace policy remain required before an open
marketplace is safe.

Airbyte adapters may later translate scheduled source records into the same
table/import services, but Airbyte is not the per-cell connector runtime.
ClickHouse projections consume completed events and never execute connectors or
hold provider credentials.

## Consequences

- Provider additions require schemas, fixed host policy, deterministic tests,
  error classification, and documentation.
- Connector manifest protocol changes require a new protocol version; provider
  behavior changes require a connector semantic-version increment.
- Built-ins are statically installed at build time. Community manifests are
  loaded from an administrator-controlled registry and run only in the optional
  isolation sidecar.
- Provider response changes fail closed at the output schema and surface as a
  non-retryable upstream contract error rather than storing unvalidated data.
- Protocol 1.0 column configurations remain readable, but literals require
  protocol 1.1 so an old deployment cannot silently reinterpret their shape.
