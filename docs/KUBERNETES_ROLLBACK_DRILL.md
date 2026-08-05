# Verify Kubernetes rollback and candidate restoration

This drill proves that a named prior Helm revision can become healthy behind
the canonical HTTPS ingress and that the exact digest-pinned release candidate
can then be restored. Run it during the candidate observation window after the
reference deployment, public ingress, external-secret provenance, and
NetworkPolicy gates pass.

The command changes the live release twice. It first rolls back to the declared
prior revision and then rolls forward by asking Helm to restore the original
candidate revision. Helm records each operation as a new history revision; the
command therefore expects the rollback and restoration to create exactly two
new revisions while preserving the original revision identities.

## Safety boundary

Use a controlled production-candidate environment with an operator-owned
maintenance window and alert routing already active. Before running:

- retain the candidate and previous release `IMAGE_DIGESTS.txt` files;
- confirm the previous application version is compatible with the current,
  forward-only database migration state;
- confirm both revisions enable the same optional workload topology and at
  least one enabled workload image digest differs;
- identify the exact deployed candidate and superseded rollback revisions with
  `helm history`;
- confirm both versions passed their own release verification;
- pause unrelated Helm changes and GitOps reconciliation for this release;
- keep a second authenticated operator session available for manual recovery;
  and
- record the current provider backup/restore point separately.

The drill requires Helm `4.2.3` or newer in the Helm 4 line. It uses the Helm 4
`--wait=watcher` behavior, a ten-minute phase timeout, and
`--cleanup-on-fail`. It refuses local HTTP origins, mismatched kubectl contexts,
mutable or unexpected workload images, unstable rollouts, pod restarts, an
undeployed candidate, or a rollback point that is not a superseded matching
revision. It also rejects a no-op active image transition even when disabled
release images differ.

Helm rollback does not reverse a completed database migration. This project
uses expand/contract migrations so the named previous image must remain
compatible with the current schema. Never use this drill as a database restore
substitute.

## Run the drill

Set these values in a trusted operator shell. The two digest manifests are the
independently verified assets for their respective releases:

```text
BYOK_GRID_KUBERNETES_ROLLBACK_CONFIRM=controlled-production-candidate
BYOK_GRID_ROLLBACK_APP_ORIGIN=https://candidate.example.com
BYOK_GRID_ROLLBACK_CANDIDATE_DIGEST_MANIFEST=/restricted/evidence/candidate/IMAGE_DIGESTS.txt
BYOK_GRID_ROLLBACK_CANDIDATE_REVISION=<currently-deployed-helm-revision>
BYOK_GRID_ROLLBACK_CANDIDATE_SHA=<40-character-candidate-commit>
BYOK_GRID_ROLLBACK_CANDIDATE_VERSION=0.1.0-rc.2
BYOK_GRID_ROLLBACK_CONTEXT=<exact-kubectl-context>
BYOK_GRID_ROLLBACK_NAMESPACE=<release-namespace>
BYOK_GRID_ROLLBACK_OPTIONAL_COMPONENTS=<sorted-comma-list-or-empty>
BYOK_GRID_ROLLBACK_PREVIOUS_DIGEST_MANIFEST=/restricted/evidence/previous/IMAGE_DIGESTS.txt
BYOK_GRID_ROLLBACK_PREVIOUS_REVISION=<named-superseded-helm-revision>
BYOK_GRID_ROLLBACK_PREVIOUS_VERSION=<previous-application-version>
BYOK_GRID_ROLLBACK_RELEASE=<helm-release-name>
```

Supported optional components are `analytics-projector` and
`connector-runner`. If both are enabled, use
`analytics-projector,connector-runner` in that exact sorted order. Then run:

```text
npm run drill:kubernetes-rollback
```

The command performs this sequence:

1. validates Helm, the active kubectl context, both digest manifests, and the
   declared Helm history;
2. proves the candidate Deployments and ready Pods use the exact candidate
   digests, have no restarts, and pass the public deployment verifier;
3. rolls back to the named prior revision and waits for Helm's watcher strategy;
4. proves the new Helm revision, live workload digests, readiness, public
   health, security headers, request correlation, and CSP nonces match the
   previous release;
5. restores the original candidate revision through Helm and waits again; and
6. repeats the live digest and public checks against the exact candidate.

Success emits one JSON line with marker
`BYOK_GRID_KUBERNETES_ROLLBACK_VERIFIED`. The record contains candidate and
previous versions, source and created Helm revisions, both digest-manifest
hashes, workload digest/count summaries, context, namespace, release, candidate
commit, verified Helm version, public-check counts, and a UTC timestamp. It contains no credentials,
Kubernetes Secret values, URLs, response bodies, or provider errors.

Retain the exact JSON line, its SHA-256, restricted Helm/Kubernetes events and
alert history for the interval, the operator identity, and the maintenance
window record. Put the exact marker, artifact hash, credential-free evidence
reference, and in-window timestamp into the production evidence manifest's
`rollback` object.

## Failure and recovery

After the first mutation is attempted, every later failure causes the command
to inspect Helm history and attempt restoration of the original candidate when
needed. It then verifies the candidate images and public endpoint before
returning the original drill failure. That recovery is operational safety, not
passing evidence.

If automatic restoration cannot be verified, the command returns a bounded
manual-recovery error. Preserve the current release state and evidence; do not
blindly repeat the drill. From the second operator session, inspect Helm history,
pods, events, ingress health, and alerts. Restore the named candidate revision
with the same context, namespace, watcher wait, and timeout only after resolving
the actual state. If the current schema is implicated, use the provider's
tested isolated-restore process instead of attempting to reverse migrations.

A failed or interrupted drill never satisfies the gate. Diagnose it in
restricted operator systems, restore a healthy candidate, open a release
blocker, and repeat only in a new controlled window.
