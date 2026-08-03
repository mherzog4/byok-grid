import {
  decideIngestionFieldUpdate,
  planCsvColumns,
  type IngestionEndpointRequest,
  type NormalizedSourceBatch,
} from '@byok-grid/domain';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from './client';
import { withIngestionDatabase } from './client';
import { recomputeDependentFormulasForRow } from './formulas';
import { recordRowMutationAndMaybeQueueSettlement } from './row-automations';
import { lockTableCellSchemaShared } from './schema-locks';
import {
  cells,
  columns,
  dataTables,
  ingestionBatches,
  ingestionEndpoints,
  ingestionRecords,
  ingestionStagedRecords,
  outboxEvents,
  rows,
  workspaceMembers,
  type SourceFieldMapping,
} from './schema';

export class IngestionAccessError extends Error {}
export class IngestionConflictError extends Error {}
export class IngestionValidationError extends Error {}

interface IngestionScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface IngestionBatchSummary {
  createdRowCount: number;
  errorMessage: string | null;
  id: string;
  recordCount: number;
  status: (typeof ingestionBatches.$inferSelect)['status'];
  updatedRowCount: number;
}

export interface IngestionEndpointSummary {
  id: string;
  lastBatch: IngestionBatchSummary | null;
  name: string;
  recordKeyField: string;
  revokedAt: Date | null;
  tokenPrefix: string;
}

export interface CreatedIngestionEndpoint extends IngestionEndpointSummary {
  token: string;
}

export interface IngestionEndpointCapability {
  endpointId: string;
  recordKeyField: string;
}

export function hashIngestionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function createIngestionEndpoint(
  db: Database,
  input: IngestionScope & IngestionEndpointRequest
): Promise<CreatedIngestionEndpoint> {
  const token = `bg_ingest_${randomBytes(32).toString('base64url')}`;
  const tokenHash = hashIngestionToken(token);
  const tokenPrefix = token.slice(0, 18);

  const endpoint = await db.transaction(async (tx) => {
    const [table] = await tx
      .select({ id: dataTables.id })
      .from(dataTables)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, dataTables.workspaceId),
          eq(workspaceMembers.userId, input.userId),
          inArray(workspaceMembers.role, ['owner', 'admin'])
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
      throw new IngestionAccessError(
        'Only workspace owners and admins can create ingestion endpoints.'
      );
    }
    const [created] = await tx
      .insert(ingestionEndpoints)
      .values({
        createdByUserId: input.userId,
        name: input.name,
        recordKeyField: input.recordKeyField,
        tableId: input.tableId,
        tokenHash,
        tokenPrefix,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created)
      throw new Error('The ingestion endpoint could not be created.');
    return created;
  });

  return { ...toEndpointSummary(endpoint, null), token };
}

export async function listIngestionEndpoints(
  db: Database,
  input: IngestionScope
): Promise<IngestionEndpointSummary[]> {
  const endpoints = await db
    .select({ endpoint: ingestionEndpoints })
    .from(ingestionEndpoints)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, ingestionEndpoints.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(ingestionEndpoints.tableId, input.tableId),
        eq(ingestionEndpoints.workspaceId, input.workspaceId)
      )
    )
    .orderBy(desc(ingestionEndpoints.createdAt))
    .limit(20);
  if (endpoints.length === 0) return [];
  const batches = await db
    .select()
    .from(ingestionBatches)
    .where(
      and(
        eq(ingestionBatches.workspaceId, input.workspaceId),
        inArray(
          ingestionBatches.endpointId,
          endpoints.map(({ endpoint }) => endpoint.id)
        )
      )
    )
    .orderBy(desc(ingestionBatches.createdAt))
    .limit(100);
  const lastBatchByEndpoint = new Map<string, IngestionBatchSummary>();
  for (const batch of batches) {
    if (!lastBatchByEndpoint.has(batch.endpointId)) {
      lastBatchByEndpoint.set(batch.endpointId, toBatchSummary(batch));
    }
  }
  return endpoints.map(({ endpoint }) =>
    toEndpointSummary(endpoint, lastBatchByEndpoint.get(endpoint.id) ?? null)
  );
}

export async function revokeIngestionEndpoint(
  db: Database,
  input: IngestionScope & { endpointId: string }
): Promise<IngestionEndpointSummary> {
  const [updated] = await db
    .update(ingestionEndpoints)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(ingestionEndpoints.id, input.endpointId),
        eq(ingestionEndpoints.tableId, input.tableId),
        eq(ingestionEndpoints.workspaceId, input.workspaceId),
        isNull(ingestionEndpoints.revokedAt)
      )
    )
    .returning();
  if (!updated)
    throw new IngestionAccessError('The endpoint is not accessible.');
  return toEndpointSummary(updated, null);
}

export async function stageIngestionBatch(
  db: Database,
  input: {
    batch: NormalizedSourceBatch;
    endpointId: string;
    idempotencyKey: string;
    requestDigest: string;
    tokenHash: string;
  }
): Promise<IngestionBatchSummary & { replayed: boolean }> {
  return withIngestionDatabase(db, input.tokenHash, async (scopedDb) => {
    const [endpoint] = await scopedDb
      .select()
      .from(ingestionEndpoints)
      .where(
        and(
          eq(ingestionEndpoints.id, input.endpointId),
          eq(ingestionEndpoints.tokenHash, input.tokenHash),
          isNull(ingestionEndpoints.revokedAt)
        )
      )
      .limit(1);
    if (!endpoint)
      throw new IngestionAccessError('The ingestion token is invalid.');

    const [created] = await scopedDb
      .insert(ingestionBatches)
      .values({
        endpointId: endpoint.id,
        fields: [...input.batch.fields],
        idempotencyKey: input.idempotencyKey,
        recordCount: input.batch.records.length,
        requestDigest: input.requestDigest,
        tableId: endpoint.tableId,
        workspaceId: endpoint.workspaceId,
      })
      .onConflictDoNothing({
        target: [ingestionBatches.endpointId, ingestionBatches.idempotencyKey],
      })
      .returning();

    if (!created) {
      const [existing] = await scopedDb
        .select()
        .from(ingestionBatches)
        .where(
          and(
            eq(ingestionBatches.endpointId, endpoint.id),
            eq(ingestionBatches.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (!existing)
        throw new Error('The ingestion replay could not be resolved.');
      if (existing.requestDigest !== input.requestDigest) {
        throw new IngestionConflictError(
          'This idempotency key was already used with a different request body.'
        );
      }
      return { ...toBatchSummary(existing), replayed: true };
    }

    await scopedDb.insert(ingestionStagedRecords).values(
      input.batch.records.map((record, index) => ({
        batchId: created.id,
        ordinal: index + 1,
        recordKey: record.key,
        values: record.values,
        workspaceId: endpoint.workspaceId,
      }))
    );
    await scopedDb.insert(outboxEvents).values({
      aggregateId: created.id,
      aggregateType: 'ingestion_batch',
      eventType: 'table.ingestion_batch_requested',
      payload: {
        batchId: created.id,
        endpointId: endpoint.id,
        tableId: endpoint.tableId,
        workspaceId: endpoint.workspaceId,
      },
      workspaceId: endpoint.workspaceId,
    });
    return { ...toBatchSummary(created), replayed: false };
  });
}

export async function getIngestionBatchStatus(
  db: Database,
  input: {
    batchId: string;
    endpointId: string;
    tokenHash: string;
  }
): Promise<IngestionBatchSummary> {
  return withIngestionDatabase(db, input.tokenHash, async (scopedDb) => {
    const [batch] = await scopedDb
      .select()
      .from(ingestionBatches)
      .where(
        and(
          eq(ingestionBatches.id, input.batchId),
          eq(ingestionBatches.endpointId, input.endpointId)
        )
      )
      .limit(1);
    if (!batch)
      throw new IngestionAccessError('The ingestion batch is not accessible.');
    return toBatchSummary(batch);
  });
}

export async function getIngestionEndpointCapability(
  db: Database,
  input: { endpointId: string; tokenHash: string }
): Promise<IngestionEndpointCapability> {
  return withIngestionDatabase(db, input.tokenHash, async (scopedDb) => {
    const [endpoint] = await scopedDb
      .select({
        endpointId: ingestionEndpoints.id,
        recordKeyField: ingestionEndpoints.recordKeyField,
      })
      .from(ingestionEndpoints)
      .where(
        and(
          eq(ingestionEndpoints.id, input.endpointId),
          eq(ingestionEndpoints.tokenHash, input.tokenHash),
          isNull(ingestionEndpoints.revokedAt)
        )
      )
      .limit(1);
    if (!endpoint) {
      throw new IngestionAccessError(
        'The ingestion endpoint is not accessible.'
      );
    }
    return endpoint;
  });
}

export async function markIngestionBatchRunning(
  db: Database,
  input: { batchId: string; endpointId: string; workspaceId: string }
): Promise<'ready' | 'succeeded' | 'cancelled' | 'waiting'> {
  return db.transaction(async (tx) => {
    const [endpoint] = await tx
      .select({ id: ingestionEndpoints.id })
      .from(ingestionEndpoints)
      .where(
        and(
          eq(ingestionEndpoints.id, input.endpointId),
          eq(ingestionEndpoints.workspaceId, input.workspaceId)
        )
      )
      .limit(1)
      .for('update');
    if (!endpoint) {
      throw new IngestionAccessError('The ingestion endpoint does not exist.');
    }
    const [batch] = await tx
      .select()
      .from(ingestionBatches)
      .where(
        and(
          eq(ingestionBatches.id, input.batchId),
          eq(ingestionBatches.endpointId, input.endpointId),
          eq(ingestionBatches.workspaceId, input.workspaceId)
        )
      )
      .limit(1)
      .for('update');
    if (!batch)
      throw new IngestionAccessError('The ingestion batch does not exist.');
    if (batch.status === 'succeeded') return 'succeeded';
    if (batch.status === 'cancelled') return 'cancelled';
    if (batch.status !== 'queued' && batch.status !== 'running') {
      throw new IngestionConflictError(
        `The ingestion batch cannot start from status ${batch.status}.`
      );
    }
    const [earlier] = await tx
      .select({ id: ingestionBatches.id })
      .from(ingestionBatches)
      .where(
        and(
          eq(ingestionBatches.endpointId, input.endpointId),
          inArray(ingestionBatches.status, ['queued', 'running']),
          or(
            lt(ingestionBatches.createdAt, batch.createdAt),
            and(
              eq(ingestionBatches.createdAt, batch.createdAt),
              lt(ingestionBatches.id, batch.id)
            )
          )
        )
      )
      .limit(1);
    if (earlier) return 'waiting';
    await tx
      .update(ingestionBatches)
      .set({
        attempt: batch.attempt + 1,
        errorMessage: null,
        startedAt: batch.startedAt ?? new Date(),
        status: 'running',
        updatedAt: new Date(),
      })
      .where(eq(ingestionBatches.id, batch.id));
    return 'ready';
  });
}

export async function applyIngestionBatchChunk(
  db: Database,
  input: {
    batchId: string;
    endpointId: string;
    tableId: string;
    workspaceId: string;
  },
  batchSize = 250
): Promise<{ done: boolean; summary: IngestionBatchSummary }> {
  return db.transaction(async (tx) => {
    const [record] = await tx
      .select({ batch: ingestionBatches, endpoint: ingestionEndpoints })
      .from(ingestionBatches)
      .innerJoin(
        ingestionEndpoints,
        and(
          eq(ingestionEndpoints.id, ingestionBatches.endpointId),
          eq(ingestionEndpoints.workspaceId, ingestionBatches.workspaceId)
        )
      )
      .where(
        and(
          eq(ingestionBatches.id, input.batchId),
          eq(ingestionBatches.endpointId, input.endpointId),
          eq(ingestionBatches.tableId, input.tableId),
          eq(ingestionBatches.workspaceId, input.workspaceId),
          eq(ingestionBatches.status, 'running')
        )
      )
      .limit(1)
      .for('update', { of: ingestionBatches });
    if (!record)
      throw new IngestionAccessError('The running batch was not found.');
    await lockTableCellSchemaShared(tx, input);

    const staged = await tx
      .select()
      .from(ingestionStagedRecords)
      .where(
        and(
          eq(ingestionStagedRecords.batchId, input.batchId),
          eq(ingestionStagedRecords.workspaceId, input.workspaceId),
          gt(ingestionStagedRecords.ordinal, record.batch.processedRecordCount)
        )
      )
      .orderBy(asc(ingestionStagedRecords.ordinal))
      .limit(Math.max(1, Math.min(batchSize, 1_000)));

    if (staged.length === 0) {
      if (record.batch.processedRecordCount !== record.batch.recordCount) {
        throw new IngestionValidationError(
          'The staged ingestion records are incomplete or out of order.'
        );
      }
      const now = new Date();
      const [completed] = await tx
        .update(ingestionBatches)
        .set({ finishedAt: now, status: 'succeeded', updatedAt: now })
        .where(eq(ingestionBatches.id, record.batch.id))
        .returning();
      await tx
        .delete(ingestionStagedRecords)
        .where(eq(ingestionStagedRecords.batchId, record.batch.id));
      await tx.insert(outboxEvents).values({
        aggregateId: record.batch.id,
        aggregateType: 'ingestion_batch',
        eventType: 'table.ingestion_batch_succeeded',
        payload: {
          batchId: record.batch.id,
          createdRowCount: record.batch.createdRowCount,
          endpointId: record.endpoint.id,
          recordCount: record.batch.recordCount,
          tableId: record.batch.tableId,
          updatedRowCount: record.batch.updatedRowCount,
        },
        workspaceId: record.batch.workspaceId,
      });
      return { done: true, summary: toBatchSummary(completed!) };
    }

    const existingColumns = await tx
      .select({
        id: columns.id,
        kind: columns.kind,
        name: columns.name,
        valueType: columns.valueType,
      })
      .from(columns)
      .where(
        and(
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt)
        )
      )
      .orderBy(asc(columns.position));
    const inputColumnIds = new Set(
      existingColumns
        .filter((column) => column.kind === 'input')
        .map((column) => column.id)
    );
    const mapping: Array<{ columnId: string; field: string }> = [
      ...(record.endpoint.fieldMapping ?? []).filter((item) =>
        inputColumnIds.has(item.columnId)
      ),
    ];
    const mappedFields = new Set(
      mapping.map((item) => normalizeField(item.field))
    );
    const newFields = record.batch.fields.filter(
      (field) => !mappedFields.has(normalizeField(field))
    );
    if (mapping.length + newFields.length > 100) {
      throw new IngestionValidationError(
        'An ingestion endpoint cannot map more than 100 fields.'
      );
    }
    const mappingStart = mapping.length;
    const plans = planCsvColumns(newFields, existingColumns);
    for (let index = 0; index < plans.length; index += 1) {
      const plan = plans[index]!;
      let columnId = plan.existingColumnId;
      if (!columnId) {
        const [created] = await tx
          .insert(columns)
          .values({
            kind: 'input',
            name: plan.columnName,
            position: `x-ingest-${record.endpoint.id}-${String(mappingStart + index).padStart(4, '0')}`,
            tableId: input.tableId,
            valueType: 'text',
            workspaceId: input.workspaceId,
          })
          .returning({ id: columns.id });
        if (!created)
          throw new Error('An ingestion column could not be created.');
        columnId = created.id;
      }
      mapping.push({ columnId, field: plan.header });
    }

    const keys = staged.map((item) => item.recordKey);
    const identities = await tx
      .select()
      .from(ingestionRecords)
      .where(
        and(
          eq(ingestionRecords.endpointId, input.endpointId),
          eq(ingestionRecords.workspaceId, input.workspaceId),
          inArray(ingestionRecords.recordKey, keys)
        )
      );
    const identityByKey = new Map(
      identities.map((identity) => [identity.recordKey, identity])
    );
    const newRecords = staged.filter(
      (item) => !identityByKey.has(item.recordKey)
    );
    if (newRecords.length > 0) {
      const rowDefinitions = newRecords.map((item) => ({
        key: item.recordKey,
        position: `${record.batch.createdAt.getTime().toString().padStart(13, '0')}-${record.batch.id}-${String(item.ordinal).padStart(6, '0')}`,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      }));
      const createdRows = await tx
        .insert(rows)
        .values(rowDefinitions.map(({ key: _key, ...row }) => row))
        .returning({ id: rows.id, position: rows.position });
      const rowIdByPosition = new Map(
        createdRows.map((row) => [row.position, row.id])
      );
      const identitiesToCreate = rowDefinitions.map((definition) => ({
        endpointId: input.endpointId,
        lastBatchId: input.batchId,
        recordKey: definition.key,
        rowId: rowIdByPosition.get(definition.position)!,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      }));
      await tx.insert(ingestionRecords).values(identitiesToCreate);
      for (const identity of identitiesToCreate) {
        identityByKey.set(identity.recordKey, {
          ...identity,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
    }

    const affectedRowIds = staged.map(
      (item) => identityByKey.get(item.recordKey)!.rowId
    );
    const mappedColumnIds = mapping.map((item) => item.columnId);
    const currentFieldByNormalized = new Map(
      record.batch.fields.map((field) => [normalizeField(field), field])
    );
    if (affectedRowIds.length > 0 && mappedColumnIds.length > 0) {
      const decideField = (item: (typeof staged)[number], field: string) => {
        const currentField = currentFieldByNormalized.get(
          normalizeField(field)
        );
        return decideIngestionFieldUpdate(
          currentField ? item.values[currentField] : undefined
        );
      };
      const changedColumnIdsForRecord = (
        item: (typeof staged)[number]
      ): string[] =>
        mapping.flatMap(({ columnId, field }) =>
          decideField(item, field).kind === 'preserve' ? [] : [columnId]
        );
      const preservesAnyField = staged.some((item) =>
        mapping.some(
          ({ field }) => decideField(item, field).kind === 'preserve'
        )
      );
      if (!preservesAnyField) {
        await tx
          .delete(cells)
          .where(
            and(
              eq(cells.tableId, input.tableId),
              eq(cells.workspaceId, input.workspaceId),
              inArray(cells.rowId, affectedRowIds),
              inArray(cells.columnId, mappedColumnIds)
            )
          );
      } else {
        for (const item of staged) {
          const changedColumnIds = changedColumnIdsForRecord(item);
          if (changedColumnIds.length === 0) continue;
          await tx
            .delete(cells)
            .where(
              and(
                eq(cells.tableId, input.tableId),
                eq(cells.workspaceId, input.workspaceId),
                eq(cells.rowId, identityByKey.get(item.recordKey)!.rowId),
                inArray(cells.columnId, changedColumnIds)
              )
            );
        }
      }
      const values = staged.flatMap((item) => {
        const rowId = identityByKey.get(item.recordKey)!.rowId;
        return mapping.flatMap(({ columnId, field }) => {
          const decision = decideField(item, field);
          return decision.kind === 'write'
            ? [
                {
                  columnId,
                  rowId,
                  tableId: input.tableId,
                  valueText: decision.value,
                  valueType: 'text' as const,
                  workspaceId: input.workspaceId,
                },
              ]
            : [];
        });
      });
      if (values.length > 0) await tx.insert(cells).values(values);
      for (const item of staged) {
        const rowId = identityByKey.get(item.recordKey)!.rowId;
        const changedColumnIds = changedColumnIdsForRecord(item);
        if (changedColumnIds.length === 0) continue;
        const changedFormulaIds = await recomputeDependentFormulasForRow(tx, {
          changedColumnIds,
          rowId,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        });
        await recordRowMutationAndMaybeQueueSettlement(tx, {
          changedColumnIds: [...changedColumnIds, ...changedFormulaIds],
          rowId,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        });
      }
    }

    await tx
      .update(ingestionRecords)
      .set({ lastBatchId: input.batchId, updatedAt: new Date() })
      .where(
        and(
          eq(ingestionRecords.endpointId, input.endpointId),
          eq(ingestionRecords.workspaceId, input.workspaceId),
          inArray(ingestionRecords.recordKey, keys)
        )
      );
    const processedRecordCount = staged.at(-1)!.ordinal;
    const [updated] = await tx
      .update(ingestionBatches)
      .set({
        createdRowCount: record.batch.createdRowCount + newRecords.length,
        processedRecordCount,
        updatedAt: new Date(),
        updatedRowCount:
          record.batch.updatedRowCount + staged.length - newRecords.length,
      })
      .where(eq(ingestionBatches.id, record.batch.id))
      .returning();
    await tx
      .update(ingestionEndpoints)
      .set({
        fieldMapping: mapping satisfies SourceFieldMapping,
        updatedAt: new Date(),
      })
      .where(eq(ingestionEndpoints.id, record.endpoint.id));
    return { done: false, summary: toBatchSummary(updated!) };
  });
}

export async function setIngestionBatchWorkerFailure(
  db: Database,
  input: {
    batchId: string;
    errorMessage: string;
    retrying: boolean;
    workspaceId: string;
  }
): Promise<void> {
  await db
    .update(ingestionBatches)
    .set({
      errorMessage: safeError(input.errorMessage),
      finishedAt: input.retrying ? null : new Date(),
      status: input.retrying ? 'queued' : 'failed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ingestionBatches.id, input.batchId),
        eq(ingestionBatches.workspaceId, input.workspaceId),
        inArray(ingestionBatches.status, ['queued', 'running'])
      )
    );
}

function normalizeField(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function safeError(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

function toBatchSummary(
  batch: typeof ingestionBatches.$inferSelect
): IngestionBatchSummary {
  return {
    createdRowCount: batch.createdRowCount,
    errorMessage: batch.errorMessage,
    id: batch.id,
    recordCount: batch.recordCount,
    status: batch.status,
    updatedRowCount: batch.updatedRowCount,
  };
}

function toEndpointSummary(
  endpoint: typeof ingestionEndpoints.$inferSelect,
  lastBatch: IngestionBatchSummary | null
): IngestionEndpointSummary {
  return {
    id: endpoint.id,
    lastBatch,
    name: endpoint.name,
    recordKeyField: endpoint.recordKeyField,
    revokedAt: endpoint.revokedAt,
    tokenPrefix: endpoint.tokenPrefix,
  };
}
