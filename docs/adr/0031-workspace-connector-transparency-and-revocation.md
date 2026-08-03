# ADR 0031: Workspace connector transparency and online revocation

- Status: Accepted
- Date: 2026-08-01

## Context

A signed community registry proves that a trusted publisher approved exact
registry bytes, but signature verification alone is not an operational trust
system. Workspace operators also need to inspect the executable identity they
are authorizing, stop a connector during an incident, and preserve evidence of
what queued work intended to run.

Connector ID and semantic version are insufficient provenance. Replacing a
registry entry's artifact while retaining the same `id@version` could otherwise
reinterpret a queued run. Removing a connector from the filesystem is also an
incomplete emergency response: it loses operator intent, produces an opaque
"not installed" failure, and does not preserve a workspace-visible incident
record.

## Decision

Every loaded community connector carries the SHA-256 digest of its Wasm
artifact, the SHA-256 digest of the exact signed registry bytes, and every
trusted publisher key ID whose detached Ed25519 signature verified. The
authenticated Next.js control plane shows those values plus version, catalog
status, actions, and fixed egress hosts. It never exposes registry filesystem
paths, credentials, or executable content.

When a community connector column is created, its configuration freezes the
artifact digest, registry digest, and verified publisher IDs. Each cell run
copies that provenance into its immutable run record. Immediately before Wasm
execution, the worker resolves the installed `id@version` and requires its
artifact digest to equal the run's frozen digest. A missing legacy pin or
same-version artifact replacement is a terminal policy failure.

Workspace owners and administrators may create active revocation records at
four scopes:

- publisher key ID;
- every version of one connector ID;
- one connector ID and semantic version;
- one exact artifact SHA-256 digest.

Revocation is checked before a column is created, before every manual, bulk, or
automatic run is queued, and again by the worker after dequeue. Artifact,
version, and connector scopes always block a match. A publisher scope blocks a
registry only when every verified co-signer is actively revoked. This permits
dual-signed key rotation: revoking the old key does not discard approval from a
verified new key. Unsigned development registries have no publisher identity,
so only connector, version, and artifact rules can match them.

Members may read workspace revocation history but cannot change it. Lifting an
active revocation requires the exact target key and timestamps the original
record with the actor; records are never deleted. Active target keys are unique
per workspace. PostgreSQL validates target shape, enforces owner/admin writes
with forced RLS, and preserves tenant isolation. The worker classifies a
revocation as terminal `connector_revoked`, avoiding provider retries and
retaining a clear run error.

Workspace revocation complements deployment control. A deployment operator
must still remove a globally compromised key from the trusted-key map or remove
the registry and restart web, worker, and runner processes. Database records do
not make an untrusted registry valid and cannot expand runner capabilities.

## Consequences

- Queued work cannot silently execute different Wasm bytes under the same
  semantic version.
- Operators can see and block exact executable identity without a hosted
  marketplace or central service.
- Revocations take effect for already queued work because the worker checks at
  execution time.
- Historical incident and lift actors remain available for audit.
- Community columns created before artifact provenance existed must be
  recreated before they can execute; silently adopting the current artifact
  would defeat the pinning guarantee.
- Deployment-wide online revocation distribution and a public transparency log
  remain future optional infrastructure; neither is required by the default
  self-hosted stack.
