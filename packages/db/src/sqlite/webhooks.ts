import {
  hasWorkspacePermission,
  webhookDestinationRequestSchema,
  webhookDestinationUpdateSchema,
  webhookPayloadSchema,
  workflowRowBatchSchema,
  type WebhookDeliveryInput,
  type WebhookDestinationRequestInput,
  type WebhookDestinationUpdate,
  type WebhookTriggerMode,
  type WorkflowRowBatch,
} from '@byok-grid/domain';
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  type SqliteDatabase,
  type SqliteTransaction,
  withSqliteWriteTransaction,
} from './client';
import { deserializeSqliteCellValue } from './cell-values';
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

export class SqliteWebhookAccessError extends Error {}
export class SqliteWebhookConflictError extends Error {}
export class SqliteWebhookValidationError extends Error {}

interface WebhookScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface SqliteWebhookDeliverySummary {
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

export interface SqliteWebhookDestinationSummary {
  endpointUrl: string;
  id: string;
  lastDelivery: SqliteWebhookDeliverySummary | null;
  lastDeliveryAt: Date | null;
  name: string;
  signingCredentialId: string;
  status: (typeof webhookDestinations.$inferSelect)['status'];
  triggerMode: WebhookTriggerMode;
}

export async function createSqliteWebhookDestination(
  db: SqliteDatabase,
  input: WebhookScope & WebhookDestinationRequestInput
): Promise<SqliteWebhookDestinationSummary> {
  const request = webhookDestinationRequestSchema.parse({
    name: input.name,
    signingCredentialId: input.signingCredentialId,
    triggerMode: input.triggerMode,
    url: input.url,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTablePermission(tx, input, 'data.write');
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
      throw new SqliteWebhookValidationError(
        'The selected webhook signing credential is missing or revoked.'
      );
    }
    const [created] = await tx
      .insert(webhookDestinations)
      .values({
        createdByUserId: input.userId,
        endpointUrl: new URL(request.url).toString(),
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

export async function listSqliteWebhookDestinations(
  db: SqliteDatabase,
  input: WebhookScope
): Promise<SqliteWebhookDestinationSummary[]> {
  await requireTablePermission(db, input, 'data.read');
  const destinations = await db
    .select()
    .from(webhookDestinations)
    .where(
      and(
        eq(webhookDestinations.tableId, input.tableId),
        eq(webhookDestinations.workspaceId, input.workspaceId)
      )
    )
    .orderBy(desc(webhookDestinations.createdAt), desc(webhookDestinations.id))
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
          destinations.map((destination) => destination.id)
        )
      )
    )
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(100);
  const latest = new Map<string, SqliteWebhookDeliverySummary>();
  for (const delivery of recentDeliveries) {
    if (!latest.has(delivery.destinationId)) {
      latest.set(delivery.destinationId, toDeliverySummary(delivery));
    }
  }
  return destinations.map((destination) =>
    toDestinationSummary(destination, latest.get(destination.id) ?? null)
  );
}

export async function updateSqliteWebhookDestination(
  db: SqliteDatabase,
  input: WebhookScope & WebhookDestinationUpdate & { destinationId: string }
): Promise<SqliteWebhookDestinationSummary> {
  const update = webhookDestinationUpdateSchema.parse({
    status: input.status,
    triggerMode: input.triggerMode,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTablePermission(tx, input, 'data.write');
    const [updated] = await tx
      .update(webhookDestinations)
      .set({ ...update, updatedAt: new Date() })
      .where(
        and(
          eq(webhookDestinations.id, input.destinationId),
          eq(webhookDestinations.tableId, input.tableId),
          eq(webhookDestinations.workspaceId, input.workspaceId)
        )
      )
      .returning();
    if (!updated) {
      throw new SqliteWebhookAccessError(
        'The webhook destination is not accessible.'
      );
    }
    return toDestinationSummary(updated, null);
  });
}

export async function queueSqliteWebhookDelivery(
  db: SqliteDatabase,
  input: WebhookScope & {
    deliveryId: string;
    destinationId: string;
    rowId: string;
  }
): Promise<SqliteWebhookDeliverySummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTablePermission(tx, input, 'data.write');
    return queueDelivery(tx, {
      deliveryId: input.deliveryId,
      dispatch: true,
      destinationId: input.destinationId,
      rowId: input.rowId,
      tableId: input.tableId,
      triggerMode: 'manual',
      workspaceId: input.workspaceId,
    });
  });
}

export async function queueSqliteWorkflowWebhookDeliveries(
  db: SqliteDatabase,
  input: {
    batch: WorkflowRowBatch;
    destinationId: string;
    runId: string;
    stepId: string;
    workspaceId: string;
  }
): Promise<WebhookDeliveryInput[]> {
  const batch = workflowRowBatchSchema.parse(input.batch);
  return withSqliteWriteTransaction(db, async (tx) => {
    const [destination] = await tx
      .select()
      .from(webhookDestinations)
      .where(
        and(
          eq(webhookDestinations.id, input.destinationId),
          eq(webhookDestinations.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!destination) {
      throw new SqliteWebhookAccessError(
        'The webhook destination does not exist.'
      );
    }
    if (destination.status !== 'active') {
      throw new SqliteWebhookConflictError(
        'The webhook destination is paused.'
      );
    }
    if (batch.rows.some((row) => row.tableId !== destination.tableId)) {
      throw new SqliteWebhookValidationError(
        'A webhook step can only deliver rows from its destination table.'
      );
    }

    const deliveries: WebhookDeliveryInput[] = [];
    for (const row of batch.rows) {
      const deliveryId = deterministicDeliveryId({
        destinationId: input.destinationId,
        rowId: row.rowId,
        runId: input.runId,
        stepId: input.stepId,
      });
      await queueDelivery(tx, {
        deliveryId,
        dispatch: false,
        destinationId: input.destinationId,
        rowId: row.rowId,
        tableId: destination.tableId,
        triggerMode: 'manual',
        workspaceId: input.workspaceId,
      });
      deliveries.push({
        deliveryId,
        destinationId: input.destinationId,
        tableId: destination.tableId,
        workspaceId: input.workspaceId,
      });
    }
    return deliveries;
  });
}

export async function queueSettledSqliteWebhookDeliveries(
  tx: SqliteTransaction,
  input: {
    rowId: string;
    rowVersion: number;
    tableId: string;
    workspaceId: string;
  }
): Promise<number> {
  const [target] = await tx
    .select({ id: rows.id })
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

  const destinations = await tx
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

  const snapshot = await loadWebhookRowSnapshot(tx, input);
  let queued = 0;
  for (const destination of destinations) {
    const deliveryId = crypto.randomUUID();
    const payload = buildWebhookPayload(snapshot, {
      deliveryId,
      triggerMode: 'row_settled',
    });
    const [created] = await tx
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
    queued += 1;
  }
  return queued;
}

export async function markSqliteWebhookDeliveryRunning(
  db: SqliteDatabase,
  input: WebhookDeliveryInput
): Promise<'ready' | 'succeeded' | 'cancelled'> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [delivery] = await tx
      .select()
      .from(webhookDeliveries)
      .where(deliveryScope(input))
      .limit(1);
    if (!delivery)
      throw new SqliteWebhookAccessError('The delivery does not exist.');
    if (delivery.status === 'succeeded') return 'succeeded';
    if (delivery.status === 'cancelled') return 'cancelled';
    if (!['queued', 'running'].includes(delivery.status)) {
      throw new SqliteWebhookConflictError(
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

export async function markSqliteWebhookDeliverySucceeded(
  db: SqliteDatabase,
  input: WebhookDeliveryInput & { responseStatus: number }
): Promise<void> {
  await withSqliteWriteTransaction(db, async (tx) => {
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
      .where(and(deliveryScope(input), eq(webhookDeliveries.status, 'running')))
      .returning({ id: webhookDeliveries.id });
    if (!succeeded) {
      throw new SqliteWebhookConflictError(
        'The webhook delivery is not running.'
      );
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

export async function setSqliteWebhookDeliveryFailure(
  db: SqliteDatabase,
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
        deliveryScope(input),
        inArray(webhookDeliveries.status, ['queued', 'running'])
      )
    );
}

async function queueDelivery(
  db: SqliteTransaction,
  input: WebhookDeliveryInput & {
    dispatch: boolean;
    rowId: string;
    triggerMode: WebhookTriggerMode;
  }
): Promise<SqliteWebhookDeliverySummary> {
  const [target] = await db
    .select({ destination: webhookDestinations, row: rows })
    .from(webhookDestinations)
    .innerJoin(
      rows,
      and(
        eq(rows.id, input.rowId),
        eq(rows.tableId, webhookDestinations.tableId),
        eq(rows.workspaceId, webhookDestinations.workspaceId)
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
    .limit(1);
  if (!target) {
    throw new SqliteWebhookAccessError(
      'The row or webhook destination is not accessible.'
    );
  }
  if (target.destination.status !== 'active') {
    throw new SqliteWebhookConflictError('The webhook destination is paused.');
  }
  const snapshot = await loadWebhookRowSnapshot(db, input);
  const payload = buildWebhookPayload(snapshot, input);
  const [created] = await db
    .insert(webhookDeliveries)
    .values({
      destinationId: input.destinationId,
      id: input.deliveryId,
      payload,
      rowId: input.rowId,
      rowVersion: target.row.version,
      tableId: input.tableId,
      triggerMode: input.triggerMode,
      workspaceId: input.workspaceId,
    })
    .onConflictDoNothing({ target: webhookDeliveries.id })
    .returning();
  if (!created) {
    const [existing] = await db
      .select()
      .from(webhookDeliveries)
      .where(deliveryScope(input))
      .limit(1);
    if (!existing || existing.rowId !== input.rowId) {
      throw new SqliteWebhookConflictError(
        'The delivery idempotency key is already in use.'
      );
    }
    return toDeliverySummary(existing);
  }
  if (input.dispatch) {
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
  }
  return toDeliverySummary(created);
}

async function requireTablePermission(
  db: Pick<SqliteDatabase, 'select'>,
  input: WebhookScope,
  permission: 'data.read' | 'data.write'
): Promise<void> {
  const [record] = await db
    .select({ role: workspaceMembers.role })
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
  if (!record || !hasWorkspacePermission(record.role, permission)) {
    throw new SqliteWebhookAccessError('The table is not accessible.');
  }
}

interface WebhookRowSnapshot {
  cells: Array<{
    columnId: string;
    name: string;
    status: (typeof cells.$inferSelect)['status'];
    value: ReturnType<typeof deserializeSqliteCellValue>;
  }>;
  row: { id: string; version: number };
  table: { id: string; name: string };
  workspaceId: string;
}

async function loadWebhookRowSnapshot(
  db: Pick<SqliteDatabase, 'select'>,
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
  if (!target) throw new SqliteWebhookAccessError('The row does not exist.');
  const byColumn = new Map(rowCells.map((cell) => [cell.columnId, cell]));
  return {
    cells: tableColumns.map((column) => {
      const cell = byColumn.get(column.id);
      return {
        columnId: column.id,
        name: column.name,
        status: cell?.status ?? 'idle',
        value: cell
          ? deserializeSqliteCellValue(cell)
          : ({ type: 'empty', value: null } as const),
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
    trigger: { mode: input.triggerMode, rowVersion: snapshot.row.version },
    version: 1,
    workspaceId: snapshot.workspaceId,
  });
}

function deterministicDeliveryId(input: {
  destinationId: string;
  rowId: string;
  runId: string;
  stepId: string;
}): string {
  const bytes = createHash('sha256')
    .update(
      `${input.runId}\0${input.stepId}\0${input.destinationId}\0${input.rowId}`
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function deliveryScope(input: WebhookDeliveryInput) {
  return and(
    eq(webhookDeliveries.id, input.deliveryId),
    eq(webhookDeliveries.destinationId, input.destinationId),
    eq(webhookDeliveries.tableId, input.tableId),
    eq(webhookDeliveries.workspaceId, input.workspaceId)
  )!;
}

function toDestinationSummary(
  destination: typeof webhookDestinations.$inferSelect,
  lastDelivery: SqliteWebhookDeliverySummary | null
): SqliteWebhookDestinationSummary {
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
): SqliteWebhookDeliverySummary {
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
