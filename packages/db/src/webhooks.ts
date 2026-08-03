import {
  webhookDestinationRequestSchema,
  webhookDestinationUpdateSchema,
  webhookPayloadSchema,
  type WebhookDeliveryInput,
  type WebhookDestinationRequestInput,
  type WebhookDestinationUpdate,
  type WebhookTriggerMode,
} from '@byok-grid/domain';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from './client';
import { deserializeCellValue } from './cell-values';
import {
  cells,
  columns,
  credentials,
  dataTables,
  outboxEvents,
  rows,
  webhookDeliveries,
  webhookDestinations,
  workspaceMembers,
} from './schema';

export class WebhookAccessError extends Error {}
export class WebhookConflictError extends Error {}
export class WebhookValidationError extends Error {}

interface WebhookScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface WebhookDeliverySummary {
  attempt: number;
  createdAt: Date;
  errorMessage: string | null;
  finishedAt: Date | null;
  id: string;
  responseStatus: number | null;
  rowId: string;
  rowVersion: number;
  status: (typeof webhookDeliveries.$inferSelect)['status'];
  triggerMode: WebhookTriggerMode;
}

export interface WebhookDestinationSummary {
  endpointUrl: string;
  id: string;
  lastDelivery: WebhookDeliverySummary | null;
  lastDeliveryAt: Date | null;
  name: string;
  signingCredentialId: string;
  status: (typeof webhookDestinations.$inferSelect)['status'];
  triggerMode: WebhookTriggerMode;
}

export async function createWebhookDestination(
  db: Database,
  input: WebhookScope & WebhookDestinationRequestInput
): Promise<WebhookDestinationSummary> {
  const request = webhookDestinationRequestSchema.parse({
    name: input.name,
    signingCredentialId: input.signingCredentialId,
    triggerMode: input.triggerMode,
    url: input.url,
  });
  const endpointUrl = new URL(request.url).toString();
  return db.transaction(async (tx) => {
    await assertWebhookTableAccess(tx as unknown as Database, input);
    const [credential] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.id, request.signingCredentialId),
          eq(credentials.workspaceId, input.workspaceId),
          eq(credentials.connectorId, 'webhook'),
          isNull(credentials.revokedAt)
        )
      )
      .limit(1);
    if (!credential) {
      throw new WebhookValidationError(
        'The selected webhook signing credential is missing or revoked.'
      );
    }
    const [created] = await tx
      .insert(webhookDestinations)
      .values({
        createdByUserId: input.userId,
        endpointUrl,
        name: request.name,
        signingCredentialId: request.signingCredentialId,
        tableId: input.tableId,
        triggerMode: request.triggerMode,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created)
      throw new Error('The webhook destination could not be created.');
    return toDestinationSummary(created, null);
  });
}

export async function listWebhookDestinations(
  db: Database,
  input: WebhookScope
): Promise<WebhookDestinationSummary[]> {
  await assertWebhookTableAccess(db, input);
  const destinations = await db
    .select({ destination: webhookDestinations })
    .from(webhookDestinations)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, webhookDestinations.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(webhookDestinations.tableId, input.tableId),
        eq(webhookDestinations.workspaceId, input.workspaceId)
      )
    )
    .orderBy(desc(webhookDestinations.createdAt))
    .limit(20);
  if (destinations.length === 0) return [];

  const recentDeliveries = await db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.workspaceId, input.workspaceId),
        inArray(
          webhookDeliveries.destinationId,
          destinations.map(({ destination }) => destination.id)
        )
      )
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(100);
  const lastDeliveryByDestination = new Map<string, WebhookDeliverySummary>();
  for (const delivery of recentDeliveries) {
    if (!lastDeliveryByDestination.has(delivery.destinationId)) {
      lastDeliveryByDestination.set(
        delivery.destinationId,
        toDeliverySummary(delivery)
      );
    }
  }
  return destinations.map(({ destination }) =>
    toDestinationSummary(
      destination,
      lastDeliveryByDestination.get(destination.id) ?? null
    )
  );
}

export async function updateWebhookDestination(
  db: Database,
  input: WebhookScope &
    WebhookDestinationUpdate & {
      destinationId: string;
    }
): Promise<WebhookDestinationSummary> {
  const update = webhookDestinationUpdateSchema.parse({
    status: input.status,
    triggerMode: input.triggerMode,
  });
  return db.transaction(async (tx) => {
    await assertWebhookTableAccess(tx as unknown as Database, input);
    const [record] = await tx
      .select({ destination: webhookDestinations })
      .from(webhookDestinations)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, webhookDestinations.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .where(
        and(
          eq(webhookDestinations.id, input.destinationId),
          eq(webhookDestinations.tableId, input.tableId),
          eq(webhookDestinations.workspaceId, input.workspaceId)
        )
      )
      .limit(1)
      .for('update', { of: webhookDestinations });
    if (!record) {
      throw new WebhookAccessError(
        'The webhook destination is not accessible.'
      );
    }
    const [updated] = await tx
      .update(webhookDestinations)
      .set({ ...update, updatedAt: new Date() })
      .where(eq(webhookDestinations.id, record.destination.id))
      .returning();
    if (!updated)
      throw new Error('The webhook destination could not be updated.');
    return toDestinationSummary(updated, null);
  });
}

export async function setWebhookDestinationStatus(
  db: Database,
  input: WebhookScope & {
    destinationId: string;
    status: 'active' | 'paused';
  }
): Promise<WebhookDestinationSummary> {
  return updateWebhookDestination(db, input);
}

export async function queueWebhookDelivery(
  db: Database,
  input: WebhookScope & {
    deliveryId: string;
    destinationId: string;
    rowId: string;
  }
): Promise<WebhookDeliverySummary> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({
        destination: webhookDestinations,
        row: rows,
        table: dataTables,
      })
      .from(webhookDestinations)
      .innerJoin(
        dataTables,
        and(
          eq(dataTables.id, webhookDestinations.tableId),
          eq(dataTables.workspaceId, webhookDestinations.workspaceId)
        )
      )
      .innerJoin(
        rows,
        and(
          eq(rows.id, input.rowId),
          eq(rows.tableId, webhookDestinations.tableId),
          eq(rows.workspaceId, webhookDestinations.workspaceId)
        )
      )
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, webhookDestinations.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .where(
        and(
          eq(webhookDestinations.id, input.destinationId),
          eq(webhookDestinations.tableId, input.tableId),
          eq(webhookDestinations.workspaceId, input.workspaceId),
          isNull(rows.archivedAt)
        )
      )
      .limit(1)
      .for('update', { of: webhookDestinations });
    if (!target) {
      throw new WebhookAccessError(
        'The row or webhook destination is not accessible.'
      );
    }
    if (target.destination.status !== 'active') {
      throw new WebhookConflictError('The webhook destination is paused.');
    }

    const snapshot = await loadWebhookRowSnapshot(tx as unknown as Database, {
      rowId: target.row.id,
      tableId: target.table.id,
      workspaceId: input.workspaceId,
    });
    const payload = buildWebhookPayload(snapshot, {
      deliveryId: input.deliveryId,
      triggerMode: 'manual',
    });
    const [created] = await tx
      .insert(webhookDeliveries)
      .values({
        destinationId: input.destinationId,
        id: input.deliveryId,
        payload,
        rowId: input.rowId,
        rowVersion: target.row.version,
        tableId: input.tableId,
        triggerMode: 'manual',
        workspaceId: input.workspaceId,
      })
      .onConflictDoNothing({ target: webhookDeliveries.id })
      .returning();
    if (!created) {
      const [existing] = await tx
        .select()
        .from(webhookDeliveries)
        .where(
          and(
            eq(webhookDeliveries.id, input.deliveryId),
            eq(webhookDeliveries.destinationId, input.destinationId),
            eq(webhookDeliveries.rowId, input.rowId),
            eq(webhookDeliveries.tableId, input.tableId),
            eq(webhookDeliveries.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!existing) {
        throw new WebhookConflictError(
          'The delivery idempotency key is already in use.'
        );
      }
      return toDeliverySummary(existing);
    }
    await tx.insert(outboxEvents).values({
      aggregateId: created.id,
      aggregateType: 'webhook_delivery',
      eventType: 'table.webhook_delivery_requested',
      payload: {
        deliveryId: created.id,
        destinationId: created.destinationId,
        tableId: created.tableId,
        workspaceId: created.workspaceId,
      } satisfies WebhookDeliveryInput,
      workspaceId: created.workspaceId,
    });
    return toDeliverySummary(created);
  });
}

export async function queueSettledWebhookDeliveries(
  db: Database,
  input: {
    rowId: string;
    rowVersion: number;
    tableId: string;
    workspaceId: string;
  }
): Promise<number> {
  const [target] = await db
    .select({ row: rows, table: dataTables })
    .from(rows)
    .innerJoin(
      dataTables,
      and(
        eq(dataTables.id, rows.tableId),
        eq(dataTables.workspaceId, rows.workspaceId)
      )
    )
    .where(
      and(
        eq(rows.id, input.rowId),
        eq(rows.version, input.rowVersion),
        eq(rows.tableId, input.tableId),
        eq(rows.workspaceId, input.workspaceId),
        isNull(rows.archivedAt),
        isNull(dataTables.archivedAt)
      )
    )
    .limit(1);
  if (!target) return 0;

  const destinations = await db
    .select({ id: webhookDestinations.id })
    .from(webhookDestinations)
    .where(
      and(
        eq(webhookDestinations.tableId, input.tableId),
        eq(webhookDestinations.workspaceId, input.workspaceId),
        eq(webhookDestinations.status, 'active'),
        eq(webhookDestinations.triggerMode, 'row_settled')
      )
    )
    .orderBy(asc(webhookDestinations.createdAt));
  if (destinations.length === 0) return 0;

  const snapshot = await loadWebhookRowSnapshot(db, input);
  let queued = 0;
  for (const destination of destinations) {
    const deliveryId = crypto.randomUUID();
    const payload = buildWebhookPayload(snapshot, {
      deliveryId,
      triggerMode: 'row_settled',
    });
    const [created] = await db
      .insert(webhookDeliveries)
      .values({
        destinationId: destination.id,
        id: deliveryId,
        payload,
        rowId: input.rowId,
        rowVersion: input.rowVersion,
        tableId: input.tableId,
        triggerMode: 'row_settled',
        workspaceId: input.workspaceId,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) continue;
    await db.insert(outboxEvents).values({
      aggregateId: created.id,
      aggregateType: 'webhook_delivery',
      eventType: 'table.webhook_delivery_requested',
      payload: {
        deliveryId: created.id,
        destinationId: created.destinationId,
        tableId: created.tableId,
        workspaceId: created.workspaceId,
      } satisfies WebhookDeliveryInput,
      workspaceId: created.workspaceId,
    });
    queued += 1;
  }
  return queued;
}

export async function markWebhookDeliveryRunning(
  db: Database,
  input: WebhookDeliveryInput
): Promise<'ready' | 'succeeded' | 'cancelled'> {
  return db.transaction(async (tx) => {
    const [delivery] = await tx
      .select()
      .from(webhookDeliveries)
      .where(
        and(
          eq(webhookDeliveries.id, input.deliveryId),
          eq(webhookDeliveries.destinationId, input.destinationId),
          eq(webhookDeliveries.tableId, input.tableId),
          eq(webhookDeliveries.workspaceId, input.workspaceId)
        )
      )
      .limit(1)
      .for('update');
    if (!delivery)
      throw new WebhookAccessError('The webhook delivery does not exist.');
    if (delivery.status === 'succeeded') return 'succeeded';
    if (delivery.status === 'cancelled') return 'cancelled';
    if (delivery.status !== 'queued' && delivery.status !== 'running') {
      throw new WebhookConflictError(
        `The webhook delivery cannot start from status ${delivery.status}.`
      );
    }
    await tx
      .update(webhookDeliveries)
      .set({
        attempt: delivery.attempt + 1,
        errorCode: null,
        errorMessage: null,
        responseStatus: null,
        startedAt: delivery.startedAt ?? new Date(),
        status: 'running',
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    return 'ready';
  });
}

export async function markWebhookDeliverySucceeded(
  db: Database,
  input: WebhookDeliveryInput & { responseStatus: number }
): Promise<void> {
  await db.transaction(async (tx) => {
    const now = new Date();
    const [succeeded] = await tx
      .update(webhookDeliveries)
      .set({
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        responseStatus: input.responseStatus,
        status: 'succeeded',
        updatedAt: now,
      })
      .where(
        and(
          eq(webhookDeliveries.id, input.deliveryId),
          eq(webhookDeliveries.destinationId, input.destinationId),
          eq(webhookDeliveries.workspaceId, input.workspaceId),
          eq(webhookDeliveries.status, 'running')
        )
      )
      .returning({ id: webhookDeliveries.id });
    if (!succeeded) {
      throw new WebhookConflictError('The webhook delivery is not running.');
    }
    await tx
      .update(webhookDestinations)
      .set({ lastDeliveryAt: now, updatedAt: now })
      .where(
        and(
          eq(webhookDestinations.id, input.destinationId),
          eq(webhookDestinations.workspaceId, input.workspaceId)
        )
      );
  });
}

export async function setWebhookDeliveryWorkerFailure(
  db: Database,
  input: WebhookDeliveryInput & {
    errorCode: string;
    errorMessage: string;
    responseStatus: number | null;
    retrying: boolean;
  }
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({
      errorCode: input.errorCode,
      errorMessage: safeErrorMessage(input.errorMessage),
      finishedAt: input.retrying ? null : new Date(),
      responseStatus: input.responseStatus,
      status: input.retrying ? 'queued' : 'failed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(webhookDeliveries.id, input.deliveryId),
        eq(webhookDeliveries.destinationId, input.destinationId),
        eq(webhookDeliveries.workspaceId, input.workspaceId),
        inArray(webhookDeliveries.status, ['queued', 'running'])
      )
    );
}

async function assertWebhookTableAccess(
  db: Database,
  input: WebhookScope
): Promise<void> {
  const [table] = await db
    .select({ id: dataTables.id })
    .from(dataTables)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, dataTables.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(dataTables.id, input.tableId),
        eq(dataTables.workspaceId, input.workspaceId),
        isNull(dataTables.archivedAt)
      )
    )
    .limit(1);
  if (!table) throw new WebhookAccessError('The table is not accessible.');
}

interface WebhookRowSnapshot {
  cells: Array<{
    columnId: string;
    name: string;
    status: (typeof cells.$inferSelect)['status'];
    value: ReturnType<typeof deserializeCellValue>;
  }>;
  row: { id: string; version: number };
  table: { id: string; name: string };
  workspaceId: string;
}

async function loadWebhookRowSnapshot(
  db: Database,
  input: { rowId: string; tableId: string; workspaceId: string }
): Promise<WebhookRowSnapshot> {
  const [[target], tableColumns, rowCells] = await Promise.all([
    db
      .select({
        rowId: rows.id,
        rowVersion: rows.version,
        tableId: dataTables.id,
        tableName: dataTables.name,
      })
      .from(rows)
      .innerJoin(
        dataTables,
        and(
          eq(dataTables.id, rows.tableId),
          eq(dataTables.workspaceId, rows.workspaceId)
        )
      )
      .where(
        and(
          eq(rows.id, input.rowId),
          eq(rows.tableId, input.tableId),
          eq(rows.workspaceId, input.workspaceId),
          isNull(rows.archivedAt),
          isNull(dataTables.archivedAt)
        )
      )
      .limit(1),
    db
      .select()
      .from(columns)
      .where(
        and(
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt)
        )
      )
      .orderBy(asc(columns.position)),
    db
      .select()
      .from(cells)
      .where(
        and(
          eq(cells.rowId, input.rowId),
          eq(cells.tableId, input.tableId),
          eq(cells.workspaceId, input.workspaceId)
        )
      ),
  ]);
  if (!target) throw new WebhookAccessError('The row does not exist.');
  const cellByColumn = new Map(rowCells.map((cell) => [cell.columnId, cell]));
  return {
    cells: tableColumns.map((column) => {
      const cell = cellByColumn.get(column.id);
      return {
        columnId: column.id,
        name: column.name,
        status: cell?.status ?? 'idle',
        value: cell
          ? deserializeCellValue(cell)
          : { type: 'empty' as const, value: null },
      };
    }),
    row: { id: target.rowId, version: target.rowVersion },
    table: { id: target.tableId, name: target.tableName },
    workspaceId: input.workspaceId,
  };
}

function buildWebhookPayload(
  snapshot: WebhookRowSnapshot,
  input: { deliveryId: string; triggerMode: WebhookTriggerMode }
) {
  return webhookPayloadSchema.parse({
    data: {
      row: {
        cells: snapshot.cells,
        id: snapshot.row.id,
        version: snapshot.row.version,
      },
      table: snapshot.table,
    },
    deliveryId: input.deliveryId,
    event: 'row.delivered',
    occurredAt: new Date().toISOString(),
    trigger: {
      mode: input.triggerMode,
      rowVersion: snapshot.row.version,
    },
    version: 1,
    workspaceId: snapshot.workspaceId,
  });
}

function toDestinationSummary(
  destination: typeof webhookDestinations.$inferSelect,
  lastDelivery: WebhookDeliverySummary | null
): WebhookDestinationSummary {
  return {
    endpointUrl: destination.endpointUrl,
    id: destination.id,
    lastDelivery,
    lastDeliveryAt: destination.lastDeliveryAt,
    name: destination.name,
    signingCredentialId: destination.signingCredentialId,
    status: destination.status,
    triggerMode: destination.triggerMode,
  };
}

function toDeliverySummary(
  delivery: typeof webhookDeliveries.$inferSelect
): WebhookDeliverySummary {
  return {
    attempt: delivery.attempt,
    createdAt: delivery.createdAt,
    errorMessage: delivery.errorMessage,
    finishedAt: delivery.finishedAt,
    id: delivery.id,
    responseStatus: delivery.responseStatus,
    rowId: delivery.rowId,
    rowVersion: delivery.rowVersion,
    status: delivery.status,
    triggerMode: delivery.triggerMode,
  };
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}
