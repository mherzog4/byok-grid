# Workspace deletion and data retention

BYOK Grid supports owner-initiated, permanent workspace deletion. SQLite/libSQL
is the authoritative product database, so the successful delete transaction
removes the live workspace and every tenant-owned row that cascades from it.
Optional analytics and operator-managed backups have separate lifecycles.

## Product deletion flow

Only a workspace owner can preview or execute deletion. The danger-zone flow:

1. reads the workspace through the authenticated, workspace-scoped repository;
2. counts affected tables, columns, rows, cells, credentials, integrations,
   memberships, invitations, execution records, and tenant audit records;
3. blocks deletion while queued, staging, or running work exists, or while an
   operator retention hold is present;
4. binds that preview to a SHA-256 digest of the workspace version, impact
   counts, active-work count, and hold state;
5. requires the exact case-sensitive workspace name, an irreversible
   acknowledgement, a reason code, and the current digest; and
6. writes a content-free receipt and deletes the workspace in one SQLite
   transaction.

The write transaction recomputes the preview before deletion and compares its
digest with the owner's confirmation. SQLite serializes the short write; a stale
confirmation is rejected rather than silently deleting a changed scope.

The retained receipt contains an opaque receipt ID, workspace and actor IDs,
reason code, aggregate impact counts, preview digest, purge timestamp, and
analytics-erasure delivery state. It contains no workspace name, table or
column names, cell values, source records, provider responses, credentials,
prompts, or webhook bodies. If the actor's user account is later deleted, its
ID is set to null.

Receipts are retained indefinitely by default as a minimal deletion audit and
ClickHouse-erasure checkpoint. A deployment may adopt a shorter compliance
period and delete completed receipts with its privileged maintenance role, but
must preserve pending or failed analytics erasures until they are resolved.

## Operator retention holds

Product routes cannot create, change, or remove holds. Use a tightly controlled
maintenance identity with direct access to the authoritative SQLite/libSQL
database. Stop application writes or use the remote libSQL service's supported
transactional client while changing a hold. Record a case or policy reference
rather than sensitive case content:

```sql
INSERT INTO workspace_purge_holds (workspace_id, reason, placed_by)
VALUES ('00000000-0000-0000-0000-000000000000',
        'Case LEGAL-123 requires preservation',
        'legal-operations@example.invalid')
ON CONFLICT (workspace_id) DO UPDATE
SET reason = EXCLUDED.reason,
    placed_by = EXCLUDED.placed_by,
    placed_at = unixepoch('subsec') * 1000;
```

Review the external authorization to lift the hold, then remove it explicitly:

```sql
DELETE FROM workspace_purge_holds
WHERE workspace_id = '00000000-0000-0000-0000-000000000000';
```

Owners see only that an operator retention hold exists. The reason and operator
identity are not exposed through the product API. The purge repository checks
the hold again inside the final write transaction, so bypassing the preview does
not bypass the hold.

## Optional ClickHouse analytics

The ClickHouse projector receives only allowlisted terminal metrics, never raw
workspace content. On purge, its receipt-driven erasure loop waits a minimum of
one hour. This grace period prevents a leased event that was already in flight
from being reinserted after deletion. The projector also filters all claimed
events against purge receipts immediately before insertion.

After the grace period, the worker issues a parameterized lightweight delete
for the workspace ID. Successful lightweight deletion makes matching rows
invisible to queries synchronously. Physical bytes are reclaimed later by
ClickHouse merges. Failed attempts retain a sanitized error, release their
lease, and retry with bounded backoff; successful attempts record
`analytics_erased_at` on the receipt.

If ClickHouse is enabled, alert on old receipts where `analytics_erased_at` is
null. Do not delete those receipts to clear an alert. Restore the projector or
ClickHouse, inspect its sanitized failure, and let the idempotent deletion
retry.

## Backups, replicas, and external systems

The product transaction cannot selectively rewrite SQLite online backups,
libSQL replicas or point-in-time history, ClickHouse snapshots, storage
snapshots, or offline exports.
Operators must define and publish their backup retention period, protect backup
access, expire old media, and test restore procedures. A restored backup may
temporarily resurrect a purged workspace; the purge receipt and erasure queue
must be restored with it, and operators must prevent normal access until
post-restore deletion obligations have been reconciled. Encryption-key
destruction can provide an additional boundary where the storage design
supports per-tenant keys, but the current schema does not claim per-workspace
cryptographic erasure for all values.

The local SQLite backup verifier, safe new-file restore flow, remote libSQL
requirements, and restore-drill evidence are documented in
[the backup and restore guide](BACKUP_RESTORE.md).

BYOK Grid cannot delete copies retained by external providers that processed a
request, user-managed Airbyte infrastructure, downstream destinations, webhook
receivers, or exported files. Workspace owners and deployment operators remain
responsible for those systems' retention policies and deletion APIs. The
bundled Airbyte destination stages data only in SQLite/libSQL and creates no
additional BYOK Grid-owned warehouse; Airbyte logs, buffers, and source state
remain under the Airbyte operator's policy.

Document the live-data, receipt, analytics, backup, log, and provider-retention
periods for each production deployment. This guide describes the repository's
mechanics, not a universal legal retention schedule.
