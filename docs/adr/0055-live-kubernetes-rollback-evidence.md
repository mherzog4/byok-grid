# ADR 0055: Live Kubernetes rollback evidence

## Status

Accepted.

## Context

Stable promotion already required an in-window rollback artifact, but the
repository did not define an executable producer for that artifact. A Helm
command returning zero is insufficient: rollback creates a new history
revision, does not reverse database migrations, and can appear successful while
Pods run unexpected mutable images or the public ingress remains unhealthy.

The release chart uses forward-only expand/contract migrations and immutable
image digests. The production gate therefore needs to prove application
rollback compatibility without claiming database rollback.

## Decision

Provide a fail-closed operator drill that:

- binds the current candidate and named prior Helm revisions to explicit
  application versions and independently verified digest manifests;
- requires Helm 4.2.3 or newer in the Helm 4 line and an exact kubectl context;
- checks stable Deployments plus Ready, restart-free Pods against immutable
  `image` and runtime `imageID` values before and after each transition;
- requires the same enabled workload topology and a digest change in at least
  one active component, preventing a disabled-adapter-only manifest difference
  from satisfying the live rollback proof;
- runs the canonical public deployment verifier in the candidate, rollback,
  and restored phases;
- treats rollback and restoration as two new monotonic Helm history revisions;
- attempts candidate restoration after any post-mutation failure and never
  converts recovery into passing evidence; and
- emits `BYOK_GRID_KUBERNETES_ROLLBACK_VERIFIED` only after the exact candidate
  is restored and reverified.

The stable production manifest requires this exact marker in its `rollback`
object alongside the retained artifact hash, reference, and in-window time.

## Consequences

- Rollback becomes behavioral production evidence instead of an operator
  assertion or command transcript.
- The drill deliberately causes two live rollouts and therefore requires a
  controlled window, paused reconciliation, alert routing, and a second
  operator recovery session.
- The prior image must remain compatible with the current database schema;
  provider backup/restore remains a separate gate.
- A failed drill may safely leave the previous application revision serving if
  candidate restoration cannot be verified. The operator must preserve that
  state and use the manual recovery path rather than repeatedly mutating Helm.
