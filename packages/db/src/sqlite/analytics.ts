import {
  ANALYTICS_EVENT_TYPES,
  type AnalyticsEventType,
  type AnalyticsSourceEvent,
} from '@byok-grid/domain';
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import { outboxEvents, workspacePurgeReceipts } from './schema';

export class SqliteAnalyticsProjectionConflictError extends Error {}

export interface SqliteClaimedAnalyticsEvent extends AnalyticsSourceEvent {
  attempt: number;
}

export interface SqliteClaimedWorkspaceAnalyticsErasure {
  attempt: number;
  receiptId: string;
  workspaceId: string;
}

export const SQLITE_WORKSPACE_ANALYTICS_ERASURE_GRACE_SECONDS = 3_600;

export async function claimSqliteAnalyticsEvents(
  db: SqliteDatabase,
  input: {
    claimId: string;
    leaseSeconds?: number;
    limit?: number;
    now?: Date;
  }
): Promise<SqliteClaimedAnalyticsEvent[]> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 100, 1_000));
  const leaseSeconds = Math.max(30, Math.min(input.leaseSeconds ?? 300, 3_600));
  const staleBefore = new Date(now.getTime() - leaseSeconds * 1_000);

  return withSqliteWriteTransaction(db, async (tx) => {
    const eligible = analyticsEventEligibility(now, staleBefore);
    const events = await tx
      .select({
        aggregateId: outboxEvents.aggregateId,
        aggregateType: outboxEvents.aggregateType,
        analyticsAttempts: outboxEvents.analyticsAttempts,
        createdAt: outboxEvents.createdAt,
        eventType: outboxEvents.eventType,
        id: outboxEvents.id,
        payload: outboxEvents.payload,
        workspaceId: outboxEvents.workspaceId,
      })
      .from(outboxEvents)
      .where(eligible)
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(limit);
    if (events.length === 0) return [];

    const ids = events.map((event) => event.id);
    const claimed = await tx
      .update(outboxEvents)
      .set({
        analyticsAttempts: sql`${outboxEvents.analyticsAttempts} + 1`,
        analyticsClaimedAt: now,
        analyticsClaimId: input.claimId,
        analyticsLastError: null,
        analyticsNextAttemptAt: null,
      })
      .where(and(inArray(outboxEvents.id, ids), eligible))
      .returning({ id: outboxEvents.id });
    if (claimed.length !== events.length) {
      throw new SqliteAnalyticsProjectionConflictError(
        'The analytics projection lease could not be acquired atomically.'
      );
    }
    return events.map((event) => ({
      aggregateId: event.aggregateId,
      aggregateType: event.aggregateType,
      attempt: event.analyticsAttempts + 1,
      createdAt: event.createdAt,
      eventType: event.eventType as AnalyticsEventType,
      id: event.id,
      payload: event.payload,
      workspaceId: event.workspaceId,
    }));
  });
}

export async function completeSqliteAnalyticsEvents(
  db: SqliteDatabase,
  input: {
    claimId: string;
    eventIds: readonly string[];
    projectedAt?: Date;
  }
): Promise<void> {
  if (input.eventIds.length === 0) return;
  const completed = await db
    .update(outboxEvents)
    .set({
      analyticsClaimedAt: null,
      analyticsClaimId: null,
      analyticsLastError: null,
      analyticsNextAttemptAt: null,
      analyticsProjectedAt: input.projectedAt ?? new Date(),
    })
    .where(
      and(
        eq(outboxEvents.analyticsClaimId, input.claimId),
        isNull(outboxEvents.analyticsProjectedAt),
        inArray(outboxEvents.id, [...input.eventIds])
      )
    )
    .returning({ id: outboxEvents.id });
  if (completed.length !== input.eventIds.length) {
    throw new SqliteAnalyticsProjectionConflictError(
      'The analytics projection lease expired before completion.'
    );
  }
}

export async function retrySqliteAnalyticsEvents(
  db: SqliteDatabase,
  input: {
    claimId: string;
    errorMessage: string;
    eventIds: readonly string[];
    retryAt: Date;
  }
): Promise<void> {
  if (input.eventIds.length === 0) return;
  const retried = await db
    .update(outboxEvents)
    .set({
      analyticsClaimedAt: null,
      analyticsClaimId: null,
      analyticsLastError: safeProjectionError(input.errorMessage),
      analyticsNextAttemptAt: input.retryAt,
    })
    .where(
      and(
        eq(outboxEvents.analyticsClaimId, input.claimId),
        isNull(outboxEvents.analyticsProjectedAt),
        inArray(outboxEvents.id, [...input.eventIds])
      )
    )
    .returning({ id: outboxEvents.id });
  if (retried.length !== input.eventIds.length) {
    throw new SqliteAnalyticsProjectionConflictError(
      'The analytics projection lease expired before retry scheduling.'
    );
  }
}

export async function listSqlitePurgedAnalyticsWorkspaceIds(
  db: SqliteDatabase,
  workspaceIds: readonly string[]
): Promise<Set<string>> {
  if (workspaceIds.length === 0) return new Set();
  const receipts = await db
    .select({ workspaceId: workspacePurgeReceipts.workspaceId })
    .from(workspacePurgeReceipts)
    .where(
      inArray(workspacePurgeReceipts.workspaceId, [...new Set(workspaceIds)])
    );
  return new Set(receipts.map((receipt) => receipt.workspaceId));
}

export async function claimSqliteWorkspaceAnalyticsErasures(
  db: SqliteDatabase,
  input: {
    claimId: string;
    graceSeconds?: number;
    leaseSeconds?: number;
    limit?: number;
    now?: Date;
  }
): Promise<SqliteClaimedWorkspaceAnalyticsErasure[]> {
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 25, 250));
  const leaseSeconds = Math.max(30, Math.min(input.leaseSeconds ?? 300, 3_600));
  const graceSeconds = Math.max(
    SQLITE_WORKSPACE_ANALYTICS_ERASURE_GRACE_SECONDS,
    input.graceSeconds ?? SQLITE_WORKSPACE_ANALYTICS_ERASURE_GRACE_SECONDS
  );
  const staleBefore = new Date(now.getTime() - leaseSeconds * 1_000);
  const readyBefore = new Date(now.getTime() - graceSeconds * 1_000);

  return withSqliteWriteTransaction(db, async (tx) => {
    const eligible = analyticsErasureEligibility(now, staleBefore, readyBefore);
    const receipts = await tx
      .select({
        analyticsEraseAttempts: workspacePurgeReceipts.analyticsEraseAttempts,
        id: workspacePurgeReceipts.id,
        workspaceId: workspacePurgeReceipts.workspaceId,
      })
      .from(workspacePurgeReceipts)
      .where(eligible)
      .orderBy(
        asc(workspacePurgeReceipts.purgedAt),
        asc(workspacePurgeReceipts.id)
      )
      .limit(limit);
    if (receipts.length === 0) return [];

    const ids = receipts.map((receipt) => receipt.id);
    const claimed = await tx
      .update(workspacePurgeReceipts)
      .set({
        analyticsEraseAttempts: sql`${workspacePurgeReceipts.analyticsEraseAttempts} + 1`,
        analyticsEraseClaimedAt: now,
        analyticsEraseClaimId: input.claimId,
        analyticsEraseLastError: null,
        analyticsEraseNextAttemptAt: null,
      })
      .where(and(inArray(workspacePurgeReceipts.id, ids), eligible))
      .returning({ id: workspacePurgeReceipts.id });
    if (claimed.length !== receipts.length) {
      throw new SqliteAnalyticsProjectionConflictError(
        'The analytics erasure lease could not be acquired atomically.'
      );
    }
    return receipts.map((receipt) => ({
      attempt: receipt.analyticsEraseAttempts + 1,
      receiptId: receipt.id,
      workspaceId: receipt.workspaceId,
    }));
  });
}

export async function completeSqliteWorkspaceAnalyticsErasure(
  db: SqliteDatabase,
  input: { claimId: string; erasedAt?: Date; receiptId: string }
): Promise<void> {
  const [completed] = await db
    .update(workspacePurgeReceipts)
    .set({
      analyticsEraseClaimedAt: null,
      analyticsEraseClaimId: null,
      analyticsEraseLastError: null,
      analyticsEraseNextAttemptAt: null,
      analyticsErasedAt: input.erasedAt ?? new Date(),
    })
    .where(
      and(
        eq(workspacePurgeReceipts.id, input.receiptId),
        eq(workspacePurgeReceipts.analyticsEraseClaimId, input.claimId),
        isNull(workspacePurgeReceipts.analyticsErasedAt)
      )
    )
    .returning({ id: workspacePurgeReceipts.id });
  if (!completed) {
    throw new SqliteAnalyticsProjectionConflictError(
      'The analytics erasure lease expired before completion.'
    );
  }
}

export async function retrySqliteWorkspaceAnalyticsErasure(
  db: SqliteDatabase,
  input: {
    claimId: string;
    errorMessage: string;
    receiptId: string;
    retryAt: Date;
  }
): Promise<void> {
  const [retried] = await db
    .update(workspacePurgeReceipts)
    .set({
      analyticsEraseClaimedAt: null,
      analyticsEraseClaimId: null,
      analyticsEraseLastError: safeProjectionError(input.errorMessage),
      analyticsEraseNextAttemptAt: input.retryAt,
    })
    .where(
      and(
        eq(workspacePurgeReceipts.id, input.receiptId),
        eq(workspacePurgeReceipts.analyticsEraseClaimId, input.claimId),
        isNull(workspacePurgeReceipts.analyticsErasedAt)
      )
    )
    .returning({ id: workspacePurgeReceipts.id });
  if (!retried) {
    throw new SqliteAnalyticsProjectionConflictError(
      'The analytics erasure lease expired before retry scheduling.'
    );
  }
}

function analyticsEventEligibility(now: Date, staleBefore: Date) {
  return and(
    inArray(outboxEvents.eventType, ANALYTICS_EVENT_TYPES),
    isNull(outboxEvents.analyticsProjectedAt),
    or(
      isNull(outboxEvents.analyticsNextAttemptAt),
      lte(outboxEvents.analyticsNextAttemptAt, now)
    ),
    or(
      isNull(outboxEvents.analyticsClaimId),
      lt(outboxEvents.analyticsClaimedAt, staleBefore)
    )
  )!;
}

function analyticsErasureEligibility(
  now: Date,
  staleBefore: Date,
  readyBefore: Date
) {
  return and(
    isNull(workspacePurgeReceipts.analyticsErasedAt),
    lte(workspacePurgeReceipts.purgedAt, readyBefore),
    or(
      isNull(workspacePurgeReceipts.analyticsEraseNextAttemptAt),
      lte(workspacePurgeReceipts.analyticsEraseNextAttemptAt, now)
    ),
    or(
      isNull(workspacePurgeReceipts.analyticsEraseClaimId),
      lt(workspacePurgeReceipts.analyticsEraseClaimedAt, staleBefore)
    )
  )!;
}

function safeProjectionError(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}
