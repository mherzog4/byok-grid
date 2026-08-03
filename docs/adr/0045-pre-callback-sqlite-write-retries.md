# ADR 0045: Retry only pre-callback SQLite write acquisition

- Status: Accepted
- Date: 2026-08-03

## Context

BYOK Grid serializes SQLite write transactions within each database handle, but
the embedded Compose topology has separate web and worker processes. Those
processes cannot share an in-memory queue. A local transaction connection waits
five seconds for a write lock and then returns `SQLITE_BUSY` or `SQLITE_LOCKED`.
Transient contention should not immediately fail otherwise safe work.

Retrying a complete transaction callback is unsafe. The callback may allocate
identifiers, append audit records, or eventually perform work whose commit
result is ambiguous. A lock error raised by application SQL can also be a real
business failure rather than failure to acquire `BEGIN IMMEDIATE`.

## Decision

The shared SQLite write helper makes at most three acquisition attempts. It
tracks whether Drizzle entered the application callback and retries only when:

- the callback has not started; and
- the machine-readable libSQL `code` or `extendedCode` belongs to the
  `SQLITE_BUSY*` or `SQLITE_LOCKED*` family.

Retries use bounded exponential jitter. After a local-file acquisition error,
the helper reconnects the libSQL client before retrying because the failed
native `BEGIN` can leave that connection unsuitable for a later commit. The
local connection-scoped foreign-key, busy-timeout, and synchronous PRAGMAs are
restored before the next attempt. Remote libSQL connections are not reset; the
server documents write transactions as a queue, and any returned lock conflict
is retried on the existing remote client.

Errors after callback entry, unknown codes, and exhausted attempts preserve the
original error. They are never converted into a generic retry. Process-local
monotonic retry and exhaustion counters are exposed on the workflow worker's
private application metrics endpoint without tenant labels or error messages.

## Consequences

- Separate local web and worker processes can recover from a short write-lock
  overlap without replaying application transaction work.
- A callback or commit failure remains visible to its caller and cannot be
  mistaken for safe acquisition failure.
- Sustained retries or any exhaustion indicate database saturation and must
  feed capacity and alert decisions; retries do not increase the supported
  concurrency envelope.
- The retry counters reset with each process and are aggregated as per-instance
  operational signals, not database-wide totals.
- Real remote-libSQL contention and failover behavior still requires evidence
  from the selected production provider.

## Verification

Unit tests cover wrapped machine codes, bounded attempts, original-error
preservation, and the no-retry-after-callback invariant. A real child process
holds a WAL write transaction beyond the five-second driver timeout while the
parent uses the production database bootstrap. The parent must observe a retry,
reset its stale local connection, commit, and verify both rows. The worker
metrics test requires the two bounded contention series and rejects database
error details on collection failure.
