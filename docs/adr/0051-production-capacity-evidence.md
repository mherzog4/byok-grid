# ADR 0051: Environment-bound production capacity evidence

- Status: Accepted
- Date: 2026-08-03

## Context

The repository has a deterministic local query benchmark, but its milliseconds
come from one developer process and a temporary local SQLite file. Treating
that number as a service limit would ignore HTTPS, authentication, ingress,
remote libSQL, concurrent optimistic writes, Hatchet dispatch, worker replicas,
and provider contention. Conversely, shipping one hard-coded "small/medium"
load profile would turn the maintainer's infrastructure assumptions into an
unsupported promise for every self-hosted deployment.

## Decision

Production capacity is an environment evidence contract. Every run declares
its dataset size, web and worker replicas, operation counts, concurrency, p95
limits, and permitted worker write-retry delta. No threshold has a passing
default. Every request must succeed, worker acquisition exhaustion is always a
failure, and the same worker pods and digest-pinned deployments must remain
stable through the measurement.

The reference drill uses an empty remote libSQL database and the canonical
HTTPS application path. Direct database writes are allowed only to seed and
remove the isolated fixture; measured grid reads, FTS search, cell writes,
workflow enqueue, and workflow completion cross production application and
worker boundaries. The evidence binds results to a candidate SHA and observed
web/worker image digests, while the retained release manifest proves the
candidate-to-digest relationship.

The tool reports a declared profile pass. Stable support limits are set below a
repeatedly observed saturation boundary and require provider, ingress, and
multi-location evidence outside the repository.

## Consequences

- Local benchmark regressions remain useful developer signals but never close
  the production capacity gate.
- Operators choose SLOs and cost/concurrency envelopes explicitly.
- A passing run on one provider or topology is not portable evidence for
  another.
- Worker process counters reveal only worker contention; web/API process and
  provider telemetry remain part of the operator record.
- The isolated fixture and empty-database postcondition make results repeatable
  and prevent accidental customer-data load testing.
- Capacity evidence must be repeated after material query, workflow, runtime,
  provider, topology, or resource-limit changes.
