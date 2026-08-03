import {
  decideAutomaticFanout,
  gridViewFilterAcceptsValueType,
  gridViewFilterLeaves,
  hubSpotPropertyValue,
  hubSpotRecordId,
  MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE,
  normalizeGridViewFilterTree,
  shouldQueueWriteback,
  writebackDestinationRequestSchema,
  writebackDestinationUpdateSchema,
  writebackPayloadSchema,
  type WritebackDeliveryInput,
  type WritebackDestinationRequest,
  type WritebackDestinationRequestInput,
  type WritebackDestinationUpdate,
  type WritebackTriggerMode,
} from '@byok-grid/domain';
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  type SqliteDatabase,
  type SqliteTransaction,
  withSqliteWriteTransaction,
} from './client';
import { deserializeSqliteCellValue } from './cell-values';
import { requireSqliteConnectorExecutionAllowed } from './connector-revocations';
import { buildSqliteGridViewFilterTreePredicate } from './grid-view-query';
import {
  cells,
  columns,
  credentials,
  dataTables,
  outboxEvents,
  rows,
  workspaceKeys,
  workspaceMembers,
  writebackDeliveries,
  writebackDestinations,
} from './schema';

export class SqliteWritebackAccessError extends Error {}
export class SqliteWritebackConflictError extends Error {}
export class SqliteWritebackValidationError extends Error {}

interface SqliteWritebackScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface SqliteWritebackDeliverySummary {
  attempt: number;
  createdAt: Date;
  errorMessage: string | null;
  finishedAt: Date | null;
  id: string;
  responseStatus: number | null;
  rowId: string;
  rowVersion: number;
  status: (typeof writebackDeliveries.$inferSelect)['status'];
  triggerMode: WritebackTriggerMode;
}

export interface SqliteWritebackDestinationSummary {
  adapterId: 'hubspot_contact';
  credentialId: string;
  fieldMappings: WritebackDestinationRequest['fieldMappings'];
  filterTree: WritebackDestinationRequest['filterTree'];
  id: string;
  lastDelivery: SqliteWritebackDeliverySummary | null;
  lastDeliveryAt: Date | null;
  name: string;
  recordIdColumnId: string;
  status: (typeof writebackDestinations.$inferSelect)['status'];
  triggerMode: WritebackTriggerMode;
}

export interface SqliteWritebackExecution {
  credential: typeof credentials.$inferSelect;
  delivery: typeof writebackDeliveries.$inferSelect;
  destination: typeof writebackDestinations.$inferSelect;
  workspaceKey: typeof workspaceKeys.$inferSelect | null;
}

export async function createSqliteWritebackDestination(
  db: SqliteDatabase,
  input: SqliteWritebackScope & WritebackDestinationRequestInput
): Promise<SqliteWritebackDestinationSummary> {
  const request = writebackDestinationRequestSchema.parse({
    credentialId: input.credentialId,
    fieldMappings: input.fieldMappings,
    filterTree: input.filterTree,
    name: input.name,
    recordIdColumnId: input.recordIdColumnId,
    triggerMode: input.triggerMode,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await assertSqliteWritebackTableAccess(tx, input);
    const [destinationCount] = await tx
      .select({ value: count() })
      .from(writebackDestinations)
      .where(
        and(
          eq(writebackDestinations.workspaceId, input.workspaceId),
          eq(writebackDestinations.tableId, input.tableId)
        )
      );
    if (
      (destinationCount?.value ?? 0) >= MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE
    ) {
      throw new SqliteWritebackValidationError(
        `A table can contain at most ${MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE} writeback destinations.`
      );
    }
    await requireSqliteConnectorExecutionAllowed(tx, input.workspaceId, {
      artifactSha256: null,
      connectorId: 'hubspot',
      connectorVersion: '1.1.0',
      publisherKeyIds: [],
    });
    const [credential] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.id, request.credentialId),
          eq(credentials.workspaceId, input.workspaceId),
          eq(credentials.connectorId, 'hubspot'),
          isNull(credentials.revokedAt)
        )
      )
      .limit(1);
    if (!credential) {
      throw new SqliteWritebackValidationError(
        'The selected HubSpot credential is missing or revoked.'
      );
    }
    await validateWritebackColumns(tx, input, request);
    const [created] = await tx
      .insert(writebackDestinations)
      .values({
        adapterId: 'hubspot_contact',
        createdByUserId: input.userId,
        credentialId: request.credentialId,
        fieldMappings: request.fieldMappings,
        filterTree: request.filterTree,
        name: request.name,
        recordIdColumnId: request.recordIdColumnId,
        tableId: input.tableId,
        triggerMode: request.triggerMode,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created)
      throw new Error('The writeback destination could not be created.');
    return toSqliteDestinationSummary(created, null);
  });
}

export async function listSqliteWritebackDestinations(
  db: SqliteDatabase,
  input: SqliteWritebackScope
): Promise<SqliteWritebackDestinationSummary[]> {
  await assertSqliteWritebackTableAccess(db, input);
  const destinations = await db
    .select({ destination: writebackDestinations })
    .from(writebackDestinations)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, writebackDestinations.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(writebackDestinations.tableId, input.tableId),
        eq(writebackDestinations.workspaceId, input.workspaceId)
      )
    )
    .orderBy(
      desc(writebackDestinations.createdAt),
      desc(writebackDestinations.id)
    )
    .limit(MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE);
  if (destinations.length === 0) return [];
  const recent = await db
    .select()
    .from(writebackDeliveries)
    .where(
      and(
        eq(writebackDeliveries.workspaceId, input.workspaceId),
        inArray(
          writebackDeliveries.destinationId,
          destinations.map(({ destination }) => destination.id)
        )
      )
    )
    .orderBy(desc(writebackDeliveries.createdAt), desc(writebackDeliveries.id))
    .limit(100);
  const latest = new Map<string, SqliteWritebackDeliverySummary>();
  for (const delivery of recent) {
    if (!latest.has(delivery.destinationId)) {
      latest.set(delivery.destinationId, toSqliteDeliverySummary(delivery));
    }
  }
  return destinations.map(({ destination }) =>
    toSqliteDestinationSummary(destination, latest.get(destination.id) ?? null)
  );
}

export async function updateSqliteWritebackDestination(
  db: SqliteDatabase,
  input: SqliteWritebackScope &
    WritebackDestinationUpdate & { destinationId: string }
): Promise<SqliteWritebackDestinationSummary> {
  const update = writebackDestinationUpdateSchema.parse({
    filterTree: input.filterTree,
    status: input.status,
    triggerMode: input.triggerMode,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await assertSqliteWritebackTableAccess(tx, input);
    const [record] = await tx
      .select({ destination: writebackDestinations })
      .from(writebackDestinations)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, writebackDestinations.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .where(
        and(
          eq(writebackDestinations.id, input.destinationId),
          eq(writebackDestinations.tableId, input.tableId),
          eq(writebackDestinations.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!record) {
      throw new SqliteWritebackAccessError(
        'The writeback destination is not accessible.'
      );
    }
    const parsed = writebackDestinationRequestSchema.safeParse({
      credentialId: record.destination.credentialId,
      fieldMappings: record.destination.fieldMappings,
      filterTree: update.filterTree ?? record.destination.filterTree,
      name: record.destination.name,
      recordIdColumnId: record.destination.recordIdColumnId,
      triggerMode: update.triggerMode ?? record.destination.triggerMode,
    });
    if (!parsed.success) {
      throw new SqliteWritebackValidationError(
        parsed.error.issues[0]?.message ?? 'The writeback update is invalid.'
      );
    }
    if ((update.status ?? record.destination.status) === 'active') {
      await validateWritebackColumns(tx, input, parsed.data);
    }
    const [updated] = await tx
      .update(writebackDestinations)
      .set({
        filterTree: parsed.data.filterTree,
        status: update.status ?? record.destination.status,
        triggerMode: parsed.data.triggerMode,
        updatedAt: new Date(),
      })
      .where(eq(writebackDestinations.id, record.destination.id))
      .returning();
    if (!updated)
      throw new Error('The writeback destination could not be updated.');
    return toSqliteDestinationSummary(updated, null);
  });
}

export async function queueSqliteWritebackDelivery(
  db: SqliteDatabase,
  input: SqliteWritebackScope & {
    deliveryId: string;
    destinationId: string;
    rowId: string;
  }
): Promise<SqliteWritebackDeliverySummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await assertSqliteWritebackTableAccess(tx, input);
    const [target] = await tx
      .select({ destination: writebackDestinations, row: rows })
      .from(writebackDestinations)
      .innerJoin(
        rows,
        and(
          eq(rows.id, input.rowId),
          eq(rows.tableId, writebackDestinations.tableId),
          eq(rows.workspaceId, writebackDestinations.workspaceId)
        )
      )
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, writebackDestinations.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .where(
        and(
          eq(writebackDestinations.id, input.destinationId),
          eq(writebackDestinations.tableId, input.tableId),
          eq(writebackDestinations.workspaceId, input.workspaceId),
          isNull(rows.archivedAt)
        )
      )
      .limit(1);
    if (!target) {
      throw new SqliteWritebackAccessError(
        'The row or writeback destination is not accessible.'
      );
    }
    const [existing] = await tx
      .select()
      .from(writebackDeliveries)
      .where(eq(writebackDeliveries.id, input.deliveryId))
      .limit(1);
    if (existing) {
      if (
        existing.destinationId !== input.destinationId ||
        existing.rowId !== input.rowId ||
        existing.tableId !== input.tableId ||
        existing.workspaceId !== input.workspaceId
      ) {
        throw new SqliteWritebackConflictError(
          'The delivery idempotency key is already in use.'
        );
      }
      return toSqliteDeliverySummary(existing);
    }
    if (target.destination.status !== 'active') {
      throw new SqliteWritebackConflictError(
        'The writeback destination is paused.'
      );
    }
    const prepared = await prepareSqliteWritebackDelivery(tx, {
      deliveryId: input.deliveryId,
      destination: target.destination,
      row: target.row,
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    });
    const [created] = await tx
      .insert(writebackDeliveries)
      .values({
        destinationId: input.destinationId,
        id: input.deliveryId,
        payload: prepared.payload,
        payloadFingerprint: prepared.payloadFingerprint,
        rowId: input.rowId,
        rowVersion: target.row.version,
        tableId: input.tableId,
        triggerMode: 'manual',
        workspaceId: input.workspaceId,
      })
      .onConflictDoNothing({ target: writebackDeliveries.id })
      .returning();
    if (!created) {
      throw new SqliteWritebackConflictError(
        'The delivery idempotency key is already in use.'
      );
    }
    await enqueueWritebackDelivery(tx, created);
    return toSqliteDeliverySummary(created);
  });
}

export type SettledSqliteWritebackResult =
  | { candidateCount: number; kind: 'blocked'; limit: number }
  | { kind: 'queued'; queuedCount: number };

export async function queueSettledSqliteWritebackDeliveries(
  tx: SqliteTransaction,
  input: {
    changedColumnIds: readonly string[];
    maximumAutomaticWritebacks: number;
    rowId: string;
    rowVersion: number;
    tableId: string;
    workspaceId: string;
  }
): Promise<SettledSqliteWritebackResult> {
  if (
    !Number.isInteger(input.maximumAutomaticWritebacks) ||
    input.maximumAutomaticWritebacks < 1
  ) {
    throw new Error('The automatic writeback fan-out limit is invalid.');
  }
  const [target] = await tx
    .select({ row: rows })
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
  if (!target) return { kind: 'queued', queuedCount: 0 };

  const destinations = await tx
    .select()
    .from(writebackDestinations)
    .where(
      and(
        eq(writebackDestinations.tableId, input.tableId),
        eq(writebackDestinations.workspaceId, input.workspaceId),
        eq(writebackDestinations.status, 'active'),
        eq(writebackDestinations.triggerMode, 'row_settled')
      )
    )
    .orderBy(asc(writebackDestinations.createdAt))
    .limit(MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE + 1);
  if (destinations.length > MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE) {
    throw new Error('The table exceeds the writeback destination limit.');
  }

  const changedColumnIds = new Set(input.changedColumnIds);
  const candidates: Array<{
    deliveryId: string;
    destination: (typeof destinations)[number];
    filterTree: WritebackDestinationRequest['filterTree'];
    prepared: Awaited<ReturnType<typeof prepareSqliteWritebackDelivery>>;
  }> = [];
  for (const destination of destinations) {
    const filterTree = normalizeGridViewFilterTree(destination.filterTree);
    const relevantColumnIds = new Set([
      destination.recordIdColumnId,
      ...destination.fieldMappings.map(({ columnId }) => columnId),
      ...gridViewFilterLeaves(filterTree).map(({ columnId }) => columnId),
    ]);
    if (![...changedColumnIds].some((id) => relevantColumnIds.has(id))) {
      continue;
    }
    const [matchingRow] = await tx
      .select({ id: rows.id })
      .from(rows)
      .where(
        and(
          eq(rows.id, input.rowId),
          eq(rows.version, input.rowVersion),
          eq(rows.tableId, input.tableId),
          eq(rows.workspaceId, input.workspaceId),
          isNull(rows.archivedAt),
          buildSqliteGridViewFilterTreePredicate(filterTree)
        )
      )
      .limit(1);
    if (!matchingRow) continue;

    const deliveryId = crypto.randomUUID();
    try {
      candidates.push({
        deliveryId,
        destination,
        filterTree,
        prepared: await prepareSqliteWritebackDelivery(tx, {
          deliveryId,
          destination,
          row: target.row,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        }),
      });
    } catch (error) {
      if (
        error instanceof SqliteWritebackConflictError ||
        error instanceof SqliteWritebackValidationError
      ) {
        continue;
      }
      throw error;
    }
  }

  const decision = decideAutomaticFanout(
    candidates.map(({ destination }) => destination.id),
    input.maximumAutomaticWritebacks
  );
  if (decision.kind === 'blocked') return decision;

  const candidateByDestinationId = new Map(
    candidates.map((candidate) => [candidate.destination.id, candidate])
  );
  let queuedCount = 0;
  for (const destinationId of decision.columnIds) {
    const candidate = candidateByDestinationId.get(destinationId)!;
    const [created] = await tx
      .insert(writebackDeliveries)
      .values({
        destinationId,
        filterTreeSnapshot: candidate.filterTree,
        id: candidate.deliveryId,
        payload: candidate.prepared.payload,
        payloadFingerprint: candidate.prepared.payloadFingerprint,
        rowId: input.rowId,
        rowVersion: input.rowVersion,
        tableId: input.tableId,
        triggerMode: 'row_settled',
        workspaceId: input.workspaceId,
      })
      .onConflictDoNothing()
      .returning();
    if (!created) continue;
    await enqueueWritebackDelivery(tx, created);
    queuedCount += 1;
  }
  return { kind: 'queued', queuedCount };
}

export async function loadSqliteWritebackExecution(
  db: SqliteDatabase,
  input: WritebackDeliveryInput
): Promise<SqliteWritebackExecution> {
  const [execution] = await db
    .select({
      credential: credentials,
      delivery: writebackDeliveries,
      destination: writebackDestinations,
      workspaceKey: workspaceKeys,
    })
    .from(writebackDeliveries)
    .innerJoin(
      writebackDestinations,
      and(
        eq(writebackDestinations.id, writebackDeliveries.destinationId),
        eq(writebackDestinations.workspaceId, writebackDeliveries.workspaceId)
      )
    )
    .innerJoin(
      credentials,
      and(
        eq(credentials.id, writebackDestinations.credentialId),
        eq(credentials.workspaceId, writebackDestinations.workspaceId)
      )
    )
    .leftJoin(
      workspaceKeys,
      eq(workspaceKeys.workspaceId, writebackDeliveries.workspaceId)
    )
    .where(deliveryScope(input))
    .limit(1);
  if (!execution) {
    throw new SqliteWritebackAccessError(
      'The writeback delivery does not exist.'
    );
  }
  return execution;
}

export async function markSqliteWritebackDeliveryRunning(
  db: SqliteDatabase,
  input: WritebackDeliveryInput
): Promise<'ready' | 'succeeded' | 'cancelled'> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [delivery] = await tx
      .select()
      .from(writebackDeliveries)
      .where(deliveryScope(input))
      .limit(1);
    if (!delivery) {
      throw new SqliteWritebackAccessError(
        'The writeback delivery does not exist.'
      );
    }
    if (delivery.status === 'succeeded') return 'succeeded';
    if (delivery.status === 'cancelled') return 'cancelled';
    if (delivery.status !== 'queued' && delivery.status !== 'running') {
      throw new SqliteWritebackConflictError(
        `The writeback delivery cannot start from status ${delivery.status}.`
      );
    }
    await tx
      .update(writebackDeliveries)
      .set({
        attempt: delivery.attempt + 1,
        errorCode: null,
        errorMessage: null,
        responseStatus: null,
        startedAt: delivery.startedAt ?? new Date(),
        status: 'running',
        updatedAt: new Date(),
      })
      .where(
        and(
          deliveryScope(input),
          inArray(writebackDeliveries.status, ['queued', 'running'])
        )
      );
    return 'ready';
  });
}

export async function markSqliteWritebackDeliverySucceeded(
  db: SqliteDatabase,
  input: WritebackDeliveryInput & { responseStatus: number }
): Promise<void> {
  await withSqliteWriteTransaction(db, async (tx) => {
    const now = new Date();
    const [succeeded] = await tx
      .update(writebackDeliveries)
      .set({
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        responseStatus: input.responseStatus,
        status: 'succeeded',
        updatedAt: now,
      })
      .where(
        and(deliveryScope(input), eq(writebackDeliveries.status, 'running'))
      )
      .returning({ id: writebackDeliveries.id });
    if (!succeeded) {
      throw new SqliteWritebackConflictError(
        'The writeback delivery is not running.'
      );
    }
    await tx
      .update(writebackDestinations)
      .set({ lastDeliveryAt: now, updatedAt: now })
      .where(
        and(
          eq(writebackDestinations.id, input.destinationId),
          eq(writebackDestinations.workspaceId, input.workspaceId)
        )
      );
  });
}

export async function setSqliteWritebackDeliveryWorkerFailure(
  db: SqliteDatabase,
  input: WritebackDeliveryInput & {
    errorCode: string;
    errorMessage: string;
    responseStatus: number | null;
    retrying: boolean;
  }
): Promise<void> {
  await db
    .update(writebackDeliveries)
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
        inArray(writebackDeliveries.status, ['queued', 'running'])
      )
    );
}

async function validateWritebackColumns(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  input: Pick<SqliteWritebackScope, 'tableId' | 'workspaceId'>,
  request: WritebackDestinationRequest
): Promise<void> {
  const requiredColumnIds = new Set([
    request.recordIdColumnId,
    ...request.fieldMappings.map(({ columnId }) => columnId),
    ...gridViewFilterLeaves(request.filterTree).map(({ columnId }) => columnId),
  ]);
  const selected = await db
    .select({ id: columns.id, valueType: columns.valueType })
    .from(columns)
    .where(
      and(
        eq(columns.tableId, input.tableId),
        eq(columns.workspaceId, input.workspaceId),
        isNull(columns.archivedAt),
        inArray(columns.id, [...requiredColumnIds])
      )
    );
  if (selected.length !== requiredColumnIds.size) {
    throw new SqliteWritebackValidationError(
      'One or more mapped columns do not belong to this table.'
    );
  }
  const typeByColumn = new Map(
    selected.map((column) => [column.id, column.valueType])
  );
  if (
    !['number', 'text'].includes(typeByColumn.get(request.recordIdColumnId)!)
  ) {
    throw new SqliteWritebackValidationError(
      'The HubSpot record ID column must contain text or numbers.'
    );
  }
  if (
    request.fieldMappings.some(
      ({ columnId }) => typeByColumn.get(columnId) === 'json'
    )
  ) {
    throw new SqliteWritebackValidationError(
      'JSON columns cannot be mapped to HubSpot properties.'
    );
  }
  for (const filter of gridViewFilterLeaves(request.filterTree)) {
    if (
      !gridViewFilterAcceptsValueType(
        filter,
        typeByColumn.get(filter.columnId)!
      )
    ) {
      throw new SqliteWritebackValidationError(
        `The ${filter.operator} operator cannot filter a ${typeByColumn.get(filter.columnId)} column.`
      );
    }
  }
}

async function prepareSqliteWritebackDelivery(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  input: {
    deliveryId: string;
    destination: typeof writebackDestinations.$inferSelect;
    row: { id: string; version: number };
    tableId: string;
    workspaceId: string;
  }
): Promise<{
  payload: ReturnType<typeof writebackPayloadSchema.parse>;
  payloadFingerprint: string;
}> {
  const request = writebackDestinationRequestSchema.parse({
    credentialId: input.destination.credentialId,
    fieldMappings: input.destination.fieldMappings,
    filterTree: input.destination.filterTree,
    name: input.destination.name,
    recordIdColumnId: input.destination.recordIdColumnId,
    triggerMode: input.destination.triggerMode,
  });
  const requiredColumnIds = new Set([
    request.recordIdColumnId,
    ...request.fieldMappings.map(({ columnId }) => columnId),
  ]);
  const rowCells = await db
    .select()
    .from(cells)
    .where(
      and(
        eq(cells.rowId, input.row.id),
        eq(cells.tableId, input.tableId),
        eq(cells.workspaceId, input.workspaceId),
        inArray(cells.columnId, [...requiredColumnIds])
      )
    );
  if (!shouldQueueWriteback(rowCells.map((cell) => cell.status))) {
    throw new SqliteWritebackConflictError(
      'Wait for mapped cells to finish before writing this row back.'
    );
  }
  const values = new Map(
    rowCells.map((cell) => [cell.columnId, deserializeSqliteCellValue(cell)])
  );
  const empty = { type: 'empty', value: null } as const;
  let recordId: string;
  const properties: Record<string, string> = {};
  try {
    recordId = hubSpotRecordId(values.get(request.recordIdColumnId) ?? empty);
    for (const mapping of request.fieldMappings) {
      properties[mapping.propertyName] = hubSpotPropertyValue(
        values.get(mapping.columnId) ?? empty
      );
    }
  } catch (error) {
    throw new SqliteWritebackValidationError(
      error instanceof Error ? error.message : 'The row cannot be written back.'
    );
  }
  return {
    payload: writebackPayloadSchema.parse({
      adapterId: 'hubspot_contact',
      deliveryId: input.deliveryId,
      occurredAt: new Date().toISOString(),
      properties,
      recordId,
      row: { id: input.row.id, version: input.row.version },
      tableId: input.tableId,
      version: 1,
      workspaceId: input.workspaceId,
    }),
    payloadFingerprint: createHash('sha256')
      .update(
        JSON.stringify({
          adapterId: 'hubspot_contact',
          properties: Object.fromEntries(
            Object.entries(properties).sort(([left], [right]) =>
              left.localeCompare(right)
            )
          ),
          recordId,
        })
      )
      .digest('hex'),
  };
}

async function assertSqliteWritebackTableAccess(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  input: SqliteWritebackScope
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
  if (!table) {
    throw new SqliteWritebackAccessError('The table is not accessible.');
  }
}

async function enqueueWritebackDelivery(
  tx: SqliteTransaction,
  delivery: typeof writebackDeliveries.$inferSelect
): Promise<void> {
  await tx.insert(outboxEvents).values({
    aggregateId: delivery.id,
    aggregateType: 'writeback_delivery',
    eventType: 'table.writeback_delivery_requested',
    payload: {
      deliveryId: delivery.id,
      destinationId: delivery.destinationId,
      tableId: delivery.tableId,
      workspaceId: delivery.workspaceId,
    } satisfies WritebackDeliveryInput,
    workspaceId: delivery.workspaceId,
  });
}

function deliveryScope(input: WritebackDeliveryInput) {
  return and(
    eq(writebackDeliveries.id, input.deliveryId),
    eq(writebackDeliveries.destinationId, input.destinationId),
    eq(writebackDeliveries.tableId, input.tableId),
    eq(writebackDeliveries.workspaceId, input.workspaceId)
  );
}

function toSqliteDestinationSummary(
  destination: typeof writebackDestinations.$inferSelect,
  lastDelivery: SqliteWritebackDeliverySummary | null
): SqliteWritebackDestinationSummary {
  if (destination.adapterId !== 'hubspot_contact') {
    throw new SqliteWritebackValidationError(
      'The writeback adapter is not installed.'
    );
  }
  return {
    adapterId: destination.adapterId,
    credentialId: destination.credentialId,
    fieldMappings: destination.fieldMappings,
    filterTree: normalizeGridViewFilterTree(destination.filterTree),
    id: destination.id,
    lastDelivery,
    lastDeliveryAt: destination.lastDeliveryAt,
    name: destination.name,
    recordIdColumnId: destination.recordIdColumnId,
    status: destination.status,
    triggerMode: destination.triggerMode,
  };
}

function toSqliteDeliverySummary(
  delivery: typeof writebackDeliveries.$inferSelect
): SqliteWritebackDeliverySummary {
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
