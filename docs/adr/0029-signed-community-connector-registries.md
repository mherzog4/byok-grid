# ADR 0029: Signed community connector registries

- Status: Accepted
- Date: 2026-08-01

## Context

ADR 0022 isolates administrator-installed connector code and pins every artifact
by SHA-256, but a digest alone says only that bytes are unchanged. It does not
identify who approved the registry that binds a manifest, credential form,
catalog visibility, artifact path, and digest. An open-source distribution path
needs publisher identity without requiring a hosted marketplace, certificate
authority, or always-online verification service.

Signing only artifact digests would leave the manifest and credential UI open
to substitution. Signing a normalized JSON form would also create cross-runtime
canonicalization risk between the TypeScript control plane and Rust runner.

## Decision

Community registries use detached Ed25519 signatures. A signature covers the
exact registry file bytes after the domain-separation prefix
`BYOK_GRID_CONNECTOR_REGISTRY_V1\0`. The adjacent version-1 signature file holds
one to 32 lowercase-hex signatures keyed by bounded publisher IDs. It may hold
multiple signatures so a deployment can overlap old and new keys during
rotation.

Operators configure an explicit JSON map from publisher key ID to a 32-byte
lowercase-hex Ed25519 public key in both the Node processes and Rust runner. A
registry is accepted when at least one detached signature verifies with a
trusted key. The web/worker and runner verify the exact bytes independently;
the runner then independently confines artifact paths, rehashes artifact bytes,
and rejects modules with imports.

Filesystem-backed registries fail closed when no trust keys exist or no trusted
signature verifies. Unsigned local development requires separate explicit Node
and runner flags and empty trust maps. Configuring any trust key restores the
signature requirement even if a development flag remains set.

Repository tooling generates an Ed25519 JWK without printing private material,
creates the private file exclusively with mode `0600`, emits a public trust map,
and adds or replaces one publisher's detached signature without discarding
other publishers. Private keys are never deployment inputs and must not be
committed.

## Consequences

- The signed unit binds catalog selection, credential forms, schemas, egress
  hosts, semantic versions, artifact paths, and artifact digests together.
- Exact-byte signing avoids a JSON canonicalization dependency, but any
  formatting or newline change requires re-signing.
- Multi-signatures allow add-new, dual-sign, roll-trust, remove-old rotation
  without accepting an unsigned interval.
- A trusted signature expresses publisher approval, not safety. Administrators
  still review source, manifests, schemas, host capabilities, build provenance,
  and artifact digests.
- Public-key distribution is operator-managed. Transparency logs, signed
  revocation statements, threshold policies, hardware-backed signing, and a
  marketplace review service remain future work.
- Detached signatures can be deleted by an attacker who can modify the mounted
  registry directory, causing startup denial of service, but cannot be replaced
  with an untrusted registry that passes verification.
- Verified signer IDs and the exact registry digest become executable
  provenance under ADR 0031. Workspace revocation can stop queued work without
  weakening signature verification; global key removal still requires a
  deployment restart.
