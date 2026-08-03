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
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from './client';
import { deserializeCellValue } from './cell-values';
import { buildGridViewFilterTreePredicate } from './grid-view-query';
import {
  cells,
  columns,
  credentials,
  dataTables,
  outboxEvents,
  rows,
  workspaceMembers,
  writebackDeliveries,
  writebackDestinations,
} from './schema';

export class WritebackAccessError extends Error {}
export class WritebackConflictError extends Error {}
export class WritebackValidationError extends Error {}

interface WritebackScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface WritebackDeliverySummary {
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

export interface WritebackDestinationSummary {
  adapterId: 'hubspot_contact';
  credentialId: string;
  fieldMappings: WritebackDestinationRequest['fieldMappings'];
  filterTree: WritebackDestinationRequest['filterTree'];
  id: string;
  lastDelivery: WritebackDeliverySummary | null;
  lastDeliveryAt: Date | null;
  name: string;
  recordIdColumnId: string;
  status: (typeof writebackDestinations.$inferSelect)['status'];
  triggerMode: WritebackTriggerMode;
}

export async function createWritebackDestination(
  db: Database,
  input: WritebackScope & WritebackDestinationRequestInput
): Promise<WritebackDestinationSummary> {
  const request = writebackDestinationRequestSchema.parse({
    credentialId: input.credentialId,
    fieldMappings: input.fieldMappings,
    filterTree: input.filterTree,
    name: input.name,
    recordIdColumnId: input.recordIdColumnId,
    triggerMode: input.triggerMode,
  });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`writeback-destinations:${input.workspaceId}:${input.tableId}`}, 0))`
    );
    await assertWritebackTableAccess(tx as unknown as Database, input);
    const [destinationCount] = await tx
      .select({ value: sql<number>`count(*)::int` })
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
      throw new WritebackValidationError(
        `A table can contain at most ${MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE} writeback destinations.`
      );
    }
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
      throw new WritebackValidationError(
        'The selected HubSpot credential is missing or revoked.'
      );
    }

    const requiredColumnIds = new Set([
      request.recordIdColumnId,
      ...request.fieldMappings.map((mapping) => mapping.columnId),
      ...gridViewFilterLeaves(request.filterTree).map(
        (filter) => filter.columnId
      ),
    ]);
    const selectedColumns = await tx
      .select({
        id: columns.id,
        name: columns.name,
        valueType: columns.valueType,
      })
      .from(columns)
      .where(
        and(
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt),
          inArray(columns.id, [...requiredColumnIds])
        )
      );
    if (selectedColumns.length !== requiredColumnIds.size) {
      throw new WritebackValidationError(
        'One or more mapped columns do not belong to this table.'
      );
    }
    const recordIdColumn = selectedColumns.find(
      (column) => column.id === request.recordIdColumnId
    )!;
    if (!['number', 'text'].includes(recordIdColumn.valueType)) {
      throw new WritebackValidationError(
        'The HubSpot record ID column must contain text or numbers.'
      );
    }
    const mappedColumnIds = new Set(
      request.fieldMappings.map((mapping) => mapping.columnId)
    );
    if (
      selectedColumns.some(
        (column) =>
          mappedColumnIds.has(column.id) && column.valueType === 'json'
      )
    ) {
      throw new WritebackValidationError(
        'JSON columns cannot be mapped to HubSpot properties.'
      );
    }
    const typeByColumn = new Map(
      selectedColumns.map((column) => [column.id, column.valueType])
    );
    for (const filter of gridViewFilterLeaves(request.filterTree)) {
      if (
        !gridViewFilterAcceptsValueType(
          filter,
          typeByColumn.get(filter.columnId)!
        )
      ) {
        throw new WritebackValidationError(
          `The ${filter.operator} operator cannot filter a ${typeByColumn.get(filter.columnId)} column.`
        );
      }
    }

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
    if (!created) {
      throw new Error('The writeback destination could not be created.');
    }
    return toDestinationSummary(created, null);
  });
}

export async function listWritebackDestinations(
  db: Database,
  input: WritebackScope
): Promise<WritebackDestinationSummary[]> {
  await assertWritebackTableAccess(db, input);
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
    .orderBy(desc(writebackDestinations.createdAt))
    .limit(MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE);
  if (destinations.length === 0) return [];

  const recentDeliveries = await db
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
    .orderBy(desc(writebackDeliveries.createdAt))
    .limit(100);
  const latest = new Map<string, WritebackDeliverySummary>();
  for (const delivery of recentDeliveries) {
    if (!latest.has(delivery.destinationId)) {
      latest.set(delivery.destinationId, toDeliverySummary(delivery));
    }
  }
  return destinations.map(({ destination }) =>
    toDestinationSummary(destination, latest.get(destination.id) ?? null)
  );
}

export async function updateWritebackDestination(
  db: Database,
  input: WritebackScope & WritebackDestinationUpdate & { destinationId: string }
): Promise<WritebackDestinationSummary> {
  const update = writebackDestinationUpdateSchema.parse({
    filterTree: input.filterTree,
    status: input.status,
    triggerMode: input.triggerMode,
  });
  return db.transaction(async (tx) => {
    await assertWritebackTableAccess(tx as unknown as Database, input);
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
      .limit(1)
      .for('update', { of: writebackDestinations });
    if (!record) {
      throw new WritebackAccessError(
        'The writeback destination is not accessible.'
      );
    }
    const parsedRequest = writebackDestinationRequestSchema.safeParse({
      credentialId: record.destination.credentialId,
      fieldMappings: record.destination.fieldMappings,
      filterTree: update.filterTree ?? record.destination.filterTree,
      name: record.destination.name,
      recordIdColumnId: record.destination.recordIdColumnId,
      triggerMode: update.triggerMode ?? record.destination.triggerMode,
    });
    if (!parsedRequest.success) {
      throw new WritebackValidationError(
        parsedRequest.error.issues[0]?.message ??
          'The writeback destination update is invalid.'
      );
    }
    const request = parsedRequest.data;
    const nextStatus = update.status ?? record.destination.status;
    if (nextStatus === 'active') {
      const mappedColumnIds = [
        ...new Set([
          record.destination.recordIdColumnId,
          ...record.destination.fieldMappings.map(
            (mapping) => mapping.columnId
          ),
          ...gridViewFilterLeaves(request.filterTree).map(
            (filter) => filter.columnId
          ),
        ]),
      ];
      const activeColumns = await tx
        .select({ id: columns.id, valueType: columns.valueType })
        .from(columns)
        .where(
          and(
            eq(columns.tableId, input.tableId),
            eq(columns.workspaceId, input.workspaceId),
            inArray(columns.id, mappedColumnIds),
            isNull(columns.archivedAt)
          )
        );
      if (activeColumns.length !== mappedColumnIds.length) {
        throw new WritebackConflictError(
          'Restore every mapped column before resuming this writeback.'
        );
      }
      const typeByColumn = new Map(
        activeColumns.map((column) => [column.id, column.valueType])
      );
      for (const filter of gridViewFilterLeaves(request.filterTree)) {
        if (
          !gridViewFilterAcceptsValueType(
            filter,
            typeByColumn.get(filter.columnId)!
          )
        ) {
          throw new WritebackValidationError(
            `The ${filter.operator} operator cannot filter a ${typeByColumn.get(filter.columnId)} column.`
          );
        }
      }
    }
    const [updated] = await tx
      .update(writebackDestinations)
      .set({
        filterTree: request.filterTree,
        status: nextStatus,
        triggerMode: request.triggerMode,
        updatedAt: new Date(),
      })
      .where(eq(writebackDestinations.id, record.destination.id))
      .returning();
    if (!updated) {
      throw new Error('The writeback destination could not be updated.');
    }
    return toDestinationSummary(updated, null);
  });
}

export async function setWritebackDestinationStatus(
  db: Database,
  input: WritebackScope & {
    destinationId: string;
    status: 'active' | 'paused';
  }
): Promise<WritebackDestinationSummary> {
  return updateWritebackDestination(db, input);
}

export async function queueWritebackDelivery(
  db: Database,
  input: WritebackScope & {
    deliveryId: string;
    destinationId: string;
    rowId: string;
  }
): Promise<WritebackDeliverySummary> {
  return db.transaction(async (tx) => {
    await assertWritebackTableAccess(tx as unknown as Database, input);
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
      .limit(1)
      .for('update', { of: writebackDestinations });
    if (!target) {
      throw new WritebackAccessError(
        'The row or writeback destination is not accessible.'
      );
    }
    const [existingCommand] = await tx
      .select()
      .from(writebackDeliveries)
      .where(eq(writebackDeliveries.id, input.deliveryId))
      .limit(1);
    if (existingCommand) {
      if (
        existingCommand.destinationId !== input.destinationId ||
        existingCommand.rowId !== input.rowId ||
        existingCommand.tableId !== input.tableId ||
        existingCommand.workspaceId !== input.workspaceId
      ) {
        throw new WritebackConflictError(
          'The delivery idempotency key is already in use.'
        );
      }
      return toDeliverySummary(existingCommand);
    }
    if (target.destination.status !== 'active') {
      throw new WritebackConflictError('The writeback destination is paused.');
    }

    const prepared = await prepareWritebackDelivery(tx as unknown as Database, {
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
      const [existing] = await tx
        .select()
        .from(writebackDeliveries)
        .where(
          and(
            eq(writebackDeliveries.id, input.deliveryId),
            eq(writebackDeliveries.destinationId, input.destinationId),
            eq(writebackDeliveries.rowId, input.rowId),
            eq(writebackDeliveries.tableId, input.tableId),
            eq(writebackDeliveries.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!existing) {
        throw new WritebackConflictError(
          'The delivery idempotency key is already in use.'
        );
      }
      return toDeliverySummary(existing);
    }
    await tx.insert(outboxEvents).values({
      aggregateId: created.id,
      aggregateType: 'writeback_delivery',
      eventType: 'table.writeback_delivery_requested',
      payload: {
        deliveryId: created.id,
        destinationId: created.destinationId,
        tableId: created.tableId,
        workspaceId: created.workspaceId,
      } satisfies WritebackDeliveryInput,
      workspaceId: created.workspaceId,
    });
    return toDeliverySummary(created);
  });
}

export type SettledWritebackResult =
  | { candidateCount: number; kind: 'blocked'; limit: number }
  | { kind: 'queued'; queuedCount: number };

export async function queueSettledWritebackDeliveries(
  db: Database,
  input: {
    changedColumnIds: readonly string[];
    maximumAutomaticWritebacks: number;
    rowId: string;
    rowVersion: number;
    tableId: string;
    workspaceId: string;
  }
): Promise<SettledWritebackResult> {
  if (
    !Number.isInteger(input.maximumAutomaticWritebacks) ||
    input.maximumAutomaticWritebacks < 1
  ) {
    throw new Error('The automatic writeback fan-out limit is invalid.');
  }
  const [target] = await db
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

  const destinations = await db
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
    prepared: Awaited<ReturnType<typeof prepareWritebackDelivery>>;
  }> = [];
  for (const destination of destinations) {
    const filterTree = normalizeGridViewFilterTree(destination.filterTree);
    const relevantColumnIds = new Set([
      destination.recordIdColumnId,
      ...destination.fieldMappings.map((mapping) => mapping.columnId),
      ...gridViewFilterLeaves(filterTree).map((filter) => filter.columnId),
    ]);
    if (![...changedColumnIds].some((id) => relevantColumnIds.has(id))) {
      continue;
    }
    const [matchingRow] = await db
      .select({ id: rows.id })
      .from(rows)
      .where(
        and(
          eq(rows.id, input.rowId),
          eq(rows.version, input.rowVersion),
          eq(rows.tableId, input.tableId),
          eq(rows.workspaceId, input.workspaceId),
          isNull(rows.archivedAt),
          buildGridViewFilterTreePredicate(filterTree)
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
        prepared: await prepareWritebackDelivery(db, {
          deliveryId,
          destination,
          row: target.row,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        }),
      });
    } catch (error) {
      if (
        error instanceof WritebackConflictError ||
        error instanceof WritebackValidationError
      ) {
        continue;
      }
      throw error;
    }
  }

  const decision = decideAutomaticFanout(
    candidates.map((candidate) => candidate.destination.id),
    input.maximumAutomaticWritebacks
  );
  if (decision.kind === 'blocked') return decision;

  const candidateByDestinationId = new Map(
    candidates.map((candidate) => [candidate.destination.id, candidate])
  );
  let queuedCount = 0;
  for (const destinationId of decision.columnIds) {
    const candidate = candidateByDestinationId.get(destinationId)!;
    const [created] = await db
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
    await db.insert(outboxEvents).values({
      aggregateId: created.id,
      aggregateType: 'writeback_delivery',
      eventType: 'table.writeback_delivery_requested',
      payload: {
        deliveryId: created.id,
        destinationId: created.destinationId,
        tableId: created.tableId,
        workspaceId: created.workspaceId,
      } satisfies WritebackDeliveryInput,
      workspaceId: created.workspaceId,
    });
    queuedCount += 1;
  }
  return { kind: 'queued', queuedCount };
}

async function prepareWritebackDelivery(
  db: Database,
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
    ...request.fieldMappings.map((mapping) => mapping.columnId),
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
    throw new WritebackConflictError(
      'Wait for mapped cells to finish before writing this row back.'
    );
  }
  const cellByColumn = new Map(
    rowCells.map((cell) => [cell.columnId, deserializeCellValue(cell)])
  );
  const empty = { type: 'empty', value: null } as const;
  let recordId: string;
  const properties: Record<string, string> = {};
  try {
    recordId = hubSpotRecordId(
      cellByColumn.get(request.recordIdColumnId) ?? empty
    );
    for (const mapping of request.fieldMappings) {
      properties[mapping.propertyName] = hubSpotPropertyValue(
        cellByColumn.get(mapping.columnId) ?? empty
      );
    }
  } catch (error) {
    throw new WritebackValidationError(
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

export async function markWritebackDeliveryRunning(
  db: Database,
  input: WritebackDeliveryInput
): Promise<'ready' | 'succeeded' | 'cancelled'> {
  return db.transaction(async (tx) => {
    const [delivery] = await tx
      .select()
      .from(writebackDeliveries)
      .where(deliveryScope(input))
      .limit(1)
      .for('update');
    if (!delivery) {
      throw new WritebackAccessError('The writeback delivery does not exist.');
    }
    if (delivery.status === 'succeeded') return 'succeeded';
    if (delivery.status === 'cancelled') return 'cancelled';
    if (delivery.status !== 'queued' && delivery.status !== 'running') {
      throw new WritebackConflictError(
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
      .where(eq(writebackDeliveries.id, delivery.id));
    return 'ready';
  });
}

export async function markWritebackDeliverySucceeded(
  db: Database,
  input: WritebackDeliveryInput & { responseStatus: number }
): Promise<void> {
  await db.transaction(async (tx) => {
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
      throw new WritebackConflictError(
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

export async function setWritebackDeliveryWorkerFailure(
  db: Database,
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

async function assertWritebackTableAccess(
  db: Database,
  input: WritebackScope
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
  if (!table) throw new WritebackAccessError('The table is not accessible.');
}

function deliveryScope(input: WritebackDeliveryInput) {
  return and(
    eq(writebackDeliveries.id, input.deliveryId),
    eq(writebackDeliveries.destinationId, input.destinationId),
    eq(writebackDeliveries.tableId, input.tableId),
    eq(writebackDeliveries.workspaceId, input.workspaceId)
  );
}

function toDestinationSummary(
  destination: typeof writebackDestinations.$inferSelect,
  lastDelivery: WritebackDeliverySummary | null
): WritebackDestinationSummary {
  if (destination.adapterId !== 'hubspot_contact') {
    throw new WritebackValidationError(
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

function toDeliverySummary(
  delivery: typeof writebackDeliveries.$inferSelect
): WritebackDeliverySummary {
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
