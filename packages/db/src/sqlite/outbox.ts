import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import { outboxEvents } from './schema';

export const DISPATCHABLE_OUTBOX_EVENT_TYPES = [
  'cell.run_requested',
  'column.bulk_run_requested',
  'table.csv_import_requested',
  'table.ingestion_batch_requested',
  'table.row_settled',
  'table.source_run_requested',
  'table.webhook_delivery_requested',
  'table.writeback_delivery_requested',
  'workflow.run_requested',
] as const;

export type DispatchableOutboxEventType =
  (typeof DISPATCHABLE_OUTBOX_EVENT_TYPES)[number];

export class SqliteOutboxClaimConflictError extends Error {}
export class SqliteOutboxClaimValidationError extends Error {}

export interface SqliteClaimedOutboxEvent {
  aggregateId: string;
  aggregateType: string;
  attempt: number;
  createdAt: Date;
  eventType: DispatchableOutboxEventType;
  id: string;
  payload: Readonly<Record<string, unknown>>;
  workspaceId: string;
}

export async function claimSqliteOutboxEvents(
  db: SqliteDatabase,
  input: {
    claimId: string;
    eventTypes?: readonly DispatchableOutboxEventType[];
    leaseSeconds?: number;
    limit?: number;
    now?: Date;
  }
): Promise<SqliteClaimedOutboxEvent[]> {
  assertClaimId(input.claimId);
  const eventTypes = input.eventTypes?.length
    ? [...new Set(input.eventTypes.map(assertDispatchableEventType))]
    : [...DISPATCHABLE_OUTBOX_EVENT_TYPES];
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 10), 100));
  const leaseSeconds = Math.max(
    30,
    Math.min(Math.trunc(input.leaseSeconds ?? 300), 3_600)
  );
  const staleBefore = new Date(now.getTime() - leaseSeconds * 1_000);

  return withSqliteWriteTransaction(db, async (tx) => {
    const eligible = dispatchEligibility(now, staleBefore, eventTypes);
    const candidates = await tx
      .select({ id: outboxEvents.id })
      .from(outboxEvents)
      .where(eligible)
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(limit);
    if (candidates.length === 0) return [];

    const orderedIds = candidates.map(({ id }) => id);
    const claimed = await tx
      .update(outboxEvents)
      .set({
        dispatchAttempts: sql`${outboxEvents.dispatchAttempts} + 1`,
        dispatchClaimedAt: now,
        dispatchClaimId: input.claimId,
        dispatchLastError: null,
        dispatchNextAttemptAt: null,
      })
      .where(and(inArray(outboxEvents.id, orderedIds), eligible))
      .returning({
        aggregateId: outboxEvents.aggregateId,
        aggregateType: outboxEvents.aggregateType,
        attempt: outboxEvents.dispatchAttempts,
        createdAt: outboxEvents.createdAt,
        eventType: outboxEvents.eventType,
        id: outboxEvents.id,
        payload: outboxEvents.payload,
        workspaceId: outboxEvents.workspaceId,
      });
    if (claimed.length !== candidates.length) {
      throw new SqliteOutboxClaimConflictError(
        'The outbox dispatch lease could not be acquired atomically.'
      );
    }

    const order = new Map(orderedIds.map((id, index) => [id, index]));
    return claimed
      .sort((left, right) => order.get(left.id)! - order.get(right.id)!)
      .map((event) => ({
        ...event,
        eventType: assertDispatchableEventType(event.eventType),
      }));
  });
}

export async function completeSqliteOutboxEvent(
  db: SqliteDatabase,
  input: { claimId: string; eventId: string; publishedAt?: Date }
): Promise<void> {
  assertClaimId(input.claimId);
  const [completed] = await db
    .update(outboxEvents)
    .set({
      dispatchClaimedAt: null,
      dispatchClaimId: null,
      dispatchLastError: null,
      dispatchNextAttemptAt: null,
      publishedAt: input.publishedAt ?? new Date(),
    })
    .where(
      and(
        eq(outboxEvents.id, input.eventId),
        eq(outboxEvents.dispatchClaimId, input.claimId),
        isNull(outboxEvents.publishedAt)
      )
    )
    .returning({ id: outboxEvents.id });
  if (!completed) {
    throw new SqliteOutboxClaimConflictError(
      'The outbox dispatch lease expired before completion.'
    );
  }
}

export async function retrySqliteOutboxEvent(
  db: SqliteDatabase,
  input: {
    claimId: string;
    errorMessage: string;
    eventId: string;
    retryAt: Date;
  }
): Promise<void> {
  assertClaimId(input.claimId);
  const [retried] = await db
    .update(outboxEvents)
    .set({
      dispatchClaimedAt: null,
      dispatchClaimId: null,
      dispatchLastError: safeDispatchError(input.errorMessage),
      dispatchNextAttemptAt: input.retryAt,
    })
    .where(
      and(
        eq(outboxEvents.id, input.eventId),
        eq(outboxEvents.dispatchClaimId, input.claimId),
        isNull(outboxEvents.publishedAt)
      )
    )
    .returning({ id: outboxEvents.id });
  if (!retried) {
    throw new SqliteOutboxClaimConflictError(
      'The outbox dispatch lease expired before retry scheduling.'
    );
  }
}

function dispatchEligibility(
  now: Date,
  staleBefore: Date,
  eventTypes: readonly DispatchableOutboxEventType[]
) {
  return and(
    inArray(outboxEvents.eventType, [...eventTypes]),
    isNull(outboxEvents.publishedAt),
    or(
      isNull(outboxEvents.dispatchNextAttemptAt),
      lte(outboxEvents.dispatchNextAttemptAt, now)
    ),
    or(
      isNull(outboxEvents.dispatchClaimId),
      lt(outboxEvents.dispatchClaimedAt, staleBefore)
    )
  )!;
}

function assertClaimId(claimId: string): void {
  if (!claimId || claimId.length > 200 || /\p{Cc}/u.test(claimId)) {
    throw new SqliteOutboxClaimValidationError(
      'The outbox claim identifier is invalid.'
    );
  }
}

function assertDispatchableEventType(
  eventType: string
): DispatchableOutboxEventType {
  if (
    !DISPATCHABLE_OUTBOX_EVENT_TYPES.includes(
      eventType as DispatchableOutboxEventType
    )
  ) {
    throw new SqliteOutboxClaimValidationError(
      `The outbox event type ${eventType} cannot be dispatched.`
    );
  }
  return eventType as DispatchableOutboxEventType;
}

function safeDispatchError(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}
