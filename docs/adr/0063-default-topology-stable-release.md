# ADR 0063: Certify the default topology at stable release

- Status: Accepted
- Date: 2026-08-05
- Supersedes: the universal stable-gate requirements in ADRs 0052, 0056, 0057,
  0059, 0060, 0061, and 0062

## Context

BYOK Grid now ships a no-account, SQLite-native single-node product by default.
Hatchet, remote libSQL, Kubernetes, Airbyte, ClickHouse, and public ingress are
optional operating choices. The original stable evidence contract nevertheless
required one hosted Kubernetes reference environment, authenticated Hatchet,
remote database recovery, ingress verification, capacity testing, native hosts,
rollback, and a 24-hour observation window for every stable release.

That policy certified one maintainer's deployment rather than the software a
developer clones. It made optional infrastructure a universal release blocker
and encouraged needless operational complexity in a fork-first project.

## Decision

Production evidence schema version 2 certifies the shipped default topology and
artifact supply chain. Every stable release requires source equivalence,
security checks, published multi-architecture smoke, independently verified
release assets, release-tag protection, the SQLite-native single-node drain,
the compiled Next.js drain, and SQLite backup/restore evidence.

Operator acceptance must follow every evidence record. The existing candidate
ancestry and seven-file promotion allowlist remain unchanged, so runtime or
release-machinery changes still require a new release candidate.

Optional Airbyte and ClickHouse support remains an explicit claim that adds its
own E2E evidence. Native-host repetition, Hatchet drain, remote libSQL recovery,
Kubernetes runtime and rollback, public-ingress validation, and production
capacity testing remain supported runbooks for deployments that make those
claims. They are not universal stable-tag gates.

## Consequences

- A developer can evaluate and release the default project using Node.js,
  Next.js, SQLite, containers, and GitHub without first operating a SaaS stack.
- Stable still fails closed on source drift, incomplete evidence, unsafe
  references, future timestamps, unverified artifacts, and unsupported adapter
  claims.
- A stable tag demonstrates that the shipped default works; it does not certify
  an arbitrary downstream operator's topology, scale envelope, identity proxy,
  backup provider, or incident process.
- Existing advanced runbooks and their verifiers remain available without
  expanding the product's default runtime or support promise.
