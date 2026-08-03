import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from './client';
import { outboxEvents } from './schema';

export const OUTBOX_DISPATCHABLE_EVENT_TYPES = [
  'cell.run_requested',
  'column.bulk_run_requested',
  'table.csv_import_requested',
  'table.ingestion_batch_requested',
  'table.row_settled',
  'table.source_run_requested',
  'table.webhook_delivery_requested',
  'table.writeback_delivery_requested',
] as const;

export type OutboxDispatchableEventType =
  (typeof OUTBOX_DISPATCHABLE_EVENT_TYPES)[number];

export class OutboxDispatchConflictError extends Error {}
export class OutboxDispatchValidationError extends Error {}

export interface ClaimedOutboxEvent {
  aggregateId: string;
  aggregateType: string;
  attempt: number;
  createdAt: Date;
  eventType: OutboxDispatchableEventType;
  id: string;
  payload: Readonly<Record<string, unknown>>;
  workspaceId: string;
}

export async function claimOutboxEvents(
  db: Database,
  input: {
    claimId: string;
    leaseSeconds?: number;
    limit?: number;
    now?: Date;
  }
): Promise<ClaimedOutboxEvent[]> {
  assertClaimId(input.claimId);
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(Math.trunc(input.limit ?? 10), 100));
  const leaseSeconds = Math.max(
    30,
    Math.min(Math.trunc(input.leaseSeconds ?? 300), 3_600)
  );
  const staleBefore = new Date(now.getTime() - leaseSeconds * 1_000);

  return db.transaction(async (tx) => {
    const eligible = dispatchEligibility(now, staleBefore);
    const candidates = await tx
      .select({
        aggregateId: outboxEvents.aggregateId,
        aggregateType: outboxEvents.aggregateType,
        attempt: outboxEvents.dispatchAttempts,
        createdAt: outboxEvents.createdAt,
        eventType: outboxEvents.eventType,
        id: outboxEvents.id,
        payload: outboxEvents.payload,
        workspaceId: outboxEvents.workspaceId,
      })
      .from(outboxEvents)
      .where(eligible)
      .orderBy(asc(outboxEvents.createdAt), asc(outboxEvents.id))
      .limit(limit)
      .for('update', { skipLocked: true });
    if (candidates.length === 0) return [];

    const ids = candidates.map(({ id }) => id);
    const claimed = await tx
      .update(outboxEvents)
      .set({
        dispatchAttempts: sql`${outboxEvents.dispatchAttempts} + 1`,
        dispatchClaimedAt: now,
        dispatchClaimId: input.claimId,
        dispatchLastError: null,
        dispatchNextAttemptAt: null,
      })
      .where(and(inArray(outboxEvents.id, ids), eligible))
      .returning({ id: outboxEvents.id });
    if (claimed.length !== candidates.length) {
      throw new OutboxDispatchConflictError(
        'The outbox dispatch lease could not be acquired atomically.'
      );
    }
    return candidates.map((event) => ({
      ...event,
      attempt: event.attempt + 1,
      eventType: assertDispatchableEventType(event.eventType),
    }));
  });
}

export async function completeOutboxEvent(
  db: Database,
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
    throw new OutboxDispatchConflictError(
      'The outbox dispatch lease expired before completion.'
    );
  }
}

export async function retryOutboxEvent(
  db: Database,
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
    throw new OutboxDispatchConflictError(
      'The outbox dispatch lease expired before retry scheduling.'
    );
  }
}

function dispatchEligibility(now: Date, staleBefore: Date) {
  return and(
    inArray(outboxEvents.eventType, [...OUTBOX_DISPATCHABLE_EVENT_TYPES]),
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
    throw new OutboxDispatchValidationError(
      'The outbox claim identifier is invalid.'
    );
  }
}

function assertDispatchableEventType(
  eventType: string
): OutboxDispatchableEventType {
  if (
    !OUTBOX_DISPATCHABLE_EVENT_TYPES.includes(
      eventType as OutboxDispatchableEventType
    )
  ) {
    throw new OutboxDispatchValidationError(
      `The outbox event type ${eventType} cannot be dispatched.`
    );
  }
  return eventType as OutboxDispatchableEventType;
}

function safeDispatchError(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}
