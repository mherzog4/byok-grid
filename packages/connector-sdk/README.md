# `@byok-grid/connector-sdk`

Apache-2.0-licensed protocol types and runtime helpers for BYOK Grid
connectors. A connector declares strict credential, input, and output schemas;
network policy; user-facing input bindings; and one or more executable actions.

The SDK deliberately has no database, queue, Next.js, or provider dependency.
Provider packages can therefore be developed and tested independently from the
AGPL application. Protocol 1.1 supports row-varying column bindings,
column-wide JSON literal bindings, and a typed cell-output projection while
retaining each action's full validated response for provenance.

Provider code receives a bounded fetch capability, an abort signal, an
execution identifier, an action-specific host set, and the decrypted
credential. It does not receive a database or queue client. Fixed-host
connectors should construct provider URLs in trusted code and classify every
error as retryable or non-retryable.

Sandbox protocol 1.0 is the serializable guest/host step contract for community
connectors. A guest returns `complete`, `failure`, or a declarative
`http_request`; the host validates and performs that request through its guarded
egress path. The SDK describes this envelope, but does not install artifacts or
grant capabilities. Deployment administrators pin community modules separately
by SHA-256 digest.

Community registry schemas are strict JSON Schema draft 2020-12 contracts.
Deployments validate credentials before encryption, action input before guest
execution, and completed output before persistence. Credential presentation is
separate declarative registry metadata so the SDK never becomes a browser-code
installation mechanism.

`npm run build` emits ESM, declarations, declaration maps, and source maps to
`dist`. The package publishes only those artifacts, this README, and the full
Apache-2.0 license.
