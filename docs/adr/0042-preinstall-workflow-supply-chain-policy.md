# ADR 0042: Verify workflow supply-chain policy before dependency install

- Status: Accepted
- Date: 2026-08-03

## Context

BYOK Grid's CI, security, and release workflows execute third-party GitHub
Actions and eventually publish images, attestations, packages, and releases.
Full commit pins and least-privilege job permissions were already present, but
future workflow edits could silently replace a pin with a mutable tag or let
checkout persist the job token for later build scripts. A policy implemented by
an installed package would itself run only after the dependency bootstrap it is
meant to protect.

Privileged event handoffs such as `pull_request_target` and `workflow_run` also
create a larger trusted/untrusted-code boundary than this repository needs.
Jobs without timeouts, concurrency controls, or explicit permissions increase
the blast radius of mistakes and compromised actions.

## Decision

The repository owns a dependency-free Node verifier that reads every workflow
under `.github/workflows`. It requires:

- external actions pinned to a 40-character commit SHA and Docker actions
  pinned to SHA-256 digests;
- `persist-credentials: false` on every `actions/checkout` step;
- no `pull_request_target` or `workflow_run` triggers;
- a top-level concurrency policy;
- a positive timeout on every job; and
- workflow-wide or job-specific mapping permissions, never scalar permission
  shortcuts; and
- GitHub tokens scoped to the individual step that consumes them rather than a
  job-wide environment.

Local actions remain allowed because their bytes come from the checked-out
commit. The gate uses only Node built-ins and runs immediately after Node setup,
before `npm ci`, in ordinary CI and the tagged release verifier. The scheduled
security workflow has an independent policy job. The release publisher uses
step-scoped `GH_TOKEN` and an explicit registry login rather than checkout's Git
credential helper.

## Consequences

- Mutable action tags and accidentally persisted checkout tokens fail CI and
  release verification.
- Contributors must update the verifier deliberately before adopting a
  privileged trigger or workflow pattern outside the current trust model.
- The repository gate does not replace GitHub-hosted Actions restrictions,
  protected branches/tags, environment approvals, or review of the pinned
  action's own transitive behavior.
- The verifier intentionally parses only the narrow workflow constructs this
  repository supports; new constructs require tests before policy expansion.

## Verification

Node tests validate the live workflows and adversarial fixtures for mutable
pins, credential persistence, privileged triggers, and missing operational
boundaries. A structural test confirms the verifier imports no runtime package.
Successful execution emits only `BYOK_GRID_WORKFLOW_POLICY_VERIFIED` with action
and workflow counts.
