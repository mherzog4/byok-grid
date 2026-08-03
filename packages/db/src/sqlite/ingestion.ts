import {
  decideIngestionFieldUpdate,
  ingestionBatchInputSchema,
  ingestionEndpointRequestSchema,
  planCsvColumns,
  type IngestionBatchInput,
  type IngestionEndpointRequest,
  type NormalizedSourceBatch,
} from '@byok-grid/domain';
import { and, asc, desc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import {
  type SqliteDatabase,
  type SqliteTransaction,
  withSqliteWriteTransaction,
} from './client';
import { recomputeDependentSqliteFormulasForRow } from './formulas';
import { recordSqliteRowMutationAndMaybeQueueSettlement } from './row-mutations';
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

export class SqliteIngestionAccessError extends Error {}
export class SqliteIngestionConflictError extends Error {}
export class SqliteIngestionValidationError extends Error {}

interface SqliteIngestionScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface SqliteIngestionBatchSummary {
  createdRowCount: number;
  errorMessage: string | null;
  id: string;
  recordCount: number;
  status: (typeof ingestionBatches.$inferSelect)['status'];
  updatedRowCount: number;
}

export interface SqliteIngestionEndpointSummary {
  id: string;
  lastBatch: SqliteIngestionBatchSummary | null;
  name: string;
  recordKeyField: string;
  revokedAt: Date | null;
  tokenPrefix: string;
}

export interface CreatedSqliteIngestionEndpoint extends SqliteIngestionEndpointSummary {
  token: string;
}

export interface SqliteIngestionEndpointCapability {
  endpointId: string;
  recordKeyField: string;
}

export function hashSqliteIngestionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export async function createSqliteIngestionEndpoint(
  db: SqliteDatabase,
  input: SqliteIngestionScope & IngestionEndpointRequest
): Promise<CreatedSqliteIngestionEndpoint> {
  const request = ingestionEndpointRequestSchema.parse({
    name: input.name,
    recordKeyField: input.recordKeyField,
  });
  const token = `bg_ingest_${randomBytes(32).toString('base64url')}`;
  const tokenHash = hashSqliteIngestionToken(token);
  const tokenPrefix = token.slice(0, 18);
  const endpoint = await withSqliteWriteTransaction(db, async (tx) => {
    await requireSqliteIngestionAdmin(tx, input);
    const [created] = await tx
      .insert(ingestionEndpoints)
      .values({
        createdByUserId: input.userId,
        name: request.name,
        recordKeyField: request.recordKeyField,
        tableId: input.tableId,
        tokenHash,
        tokenPrefix,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created) {
      throw new Error('The ingestion endpoint could not be created.');
    }
    return created;
  });
  return { ...toSqliteEndpointSummary(endpoint, null), token };
}

export async function listSqliteIngestionEndpoints(
  db: SqliteDatabase,
  input: SqliteIngestionScope
): Promise<SqliteIngestionEndpointSummary[]> {
  await requireSqliteIngestionMember(db, input);
  const endpoints = await db
    .select()
    .from(ingestionEndpoints)
    .where(
      and(
        eq(ingestionEndpoints.tableId, input.tableId),
        eq(ingestionEndpoints.workspaceId, input.workspaceId)
      )
    )
    .orderBy(desc(ingestionEndpoints.createdAt), desc(ingestionEndpoints.id))
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
          endpoints.map(({ id }) => id)
        )
      )
    )
    .orderBy(desc(ingestionBatches.createdAt), desc(ingestionBatches.id))
    .limit(100);
  const lastBatchByEndpoint = new Map<string, SqliteIngestionBatchSummary>();
  for (const batch of batches) {
    if (!lastBatchByEndpoint.has(batch.endpointId)) {
      lastBatchByEndpoint.set(batch.endpointId, toSqliteBatchSummary(batch));
    }
  }
  return endpoints.map((endpoint) =>
    toSqliteEndpointSummary(
      endpoint,
      lastBatchByEndpoint.get(endpoint.id) ?? null
    )
  );
}

export async function revokeSqliteIngestionEndpoint(
  db: SqliteDatabase,
  input: SqliteIngestionScope & { endpointId: string }
): Promise<SqliteIngestionEndpointSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireSqliteIngestionAdmin(tx, input);
    const [updated] = await tx
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
    if (!updated) {
      throw new SqliteIngestionAccessError('The endpoint is not accessible.');
    }
    return toSqliteEndpointSummary(updated, null);
  });
}

export async function stageSqliteIngestionBatch(
  db: SqliteDatabase,
  input: {
    batch: NormalizedSourceBatch;
    endpointId: string;
    idempotencyKey: string;
    requestDigest: string;
    tokenHash: string;
  }
): Promise<SqliteIngestionBatchSummary & { replayed: boolean }> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [endpoint] = await tx
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
    if (!endpoint) {
      throw new SqliteIngestionAccessError('The ingestion token is invalid.');
    }

    const [created] = await tx
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
      const [existing] = await tx
        .select()
        .from(ingestionBatches)
        .where(
          and(
            eq(ingestionBatches.endpointId, endpoint.id),
            eq(ingestionBatches.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (!existing) {
        throw new Error('The ingestion replay could not be resolved.');
      }
      if (existing.requestDigest !== input.requestDigest) {
        throw new SqliteIngestionConflictError(
          'This idempotency key was already used with a different request body.'
        );
      }
      return { ...toSqliteBatchSummary(existing), replayed: true };
    }

    await tx.insert(ingestionStagedRecords).values(
      input.batch.records.map((record, index) => ({
        batchId: created.id,
        ordinal: index + 1,
        recordKey: record.key,
        values: record.values,
        workspaceId: endpoint.workspaceId,
      }))
    );
    const workerInput = ingestionBatchInputSchema.parse({
      batchId: created.id,
      endpointId: endpoint.id,
      tableId: endpoint.tableId,
      workspaceId: endpoint.workspaceId,
    });
    await tx.insert(outboxEvents).values({
      aggregateId: created.id,
      aggregateType: 'ingestion_batch',
      eventType: 'table.ingestion_batch_requested',
      payload: workerInput,
      workspaceId: endpoint.workspaceId,
    });
    return { ...toSqliteBatchSummary(created), replayed: false };
  });
}

export async function getSqliteIngestionBatchStatus(
  db: SqliteDatabase,
  input: { batchId: string; endpointId: string; tokenHash: string }
): Promise<SqliteIngestionBatchSummary> {
  const [batch] = await db
    .select({ batch: ingestionBatches })
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
        eq(ingestionEndpoints.tokenHash, input.tokenHash),
        isNull(ingestionEndpoints.revokedAt)
      )
    )
    .limit(1);
  if (!batch) {
    throw new SqliteIngestionAccessError(
      'The ingestion batch is not accessible.'
    );
  }
  return toSqliteBatchSummary(batch.batch);
}

export async function getSqliteIngestionEndpointCapability(
  db: SqliteDatabase,
  input: { endpointId: string; tokenHash: string }
): Promise<SqliteIngestionEndpointCapability> {
  const [endpoint] = await db
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
    throw new SqliteIngestionAccessError(
      'The ingestion endpoint is not accessible.'
    );
  }
  return endpoint;
}

export async function markSqliteIngestionBatchRunning(
  db: SqliteDatabase,
  rawInput: IngestionBatchInput
): Promise<'ready' | 'succeeded' | 'cancelled' | 'waiting'> {
  const input = ingestionBatchInputSchema.parse(rawInput);
  return withSqliteWriteTransaction(db, async (tx) => {
    const [batch] = await tx
      .select()
      .from(ingestionBatches)
      .where(
        and(
          eq(ingestionBatches.id, input.batchId),
          eq(ingestionBatches.endpointId, input.endpointId),
          eq(ingestionBatches.tableId, input.tableId),
          eq(ingestionBatches.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!batch) {
      throw new SqliteIngestionAccessError(
        'The ingestion batch does not exist.'
      );
    }
    if (batch.status === 'succeeded') return 'succeeded';
    if (batch.status === 'cancelled') return 'cancelled';
    if (batch.status !== 'queued' && batch.status !== 'running') {
      throw new SqliteIngestionConflictError(
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
      .where(
        and(
          eq(ingestionBatches.id, batch.id),
          inArray(ingestionBatches.status, ['queued', 'running'])
        )
      );
    return 'ready';
  });
}

export async function applySqliteIngestionBatchChunk(
  db: SqliteDatabase,
  rawInput: IngestionBatchInput,
  batchSize = 250
): Promise<{ done: boolean; summary: SqliteIngestionBatchSummary }> {
  const input = ingestionBatchInputSchema.parse(rawInput);
  return withSqliteWriteTransaction(db, async (tx) => {
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
      .limit(1);
    if (!record) {
      throw new SqliteIngestionAccessError(
        'The running ingestion batch was not found.'
      );
    }

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
        throw new SqliteIngestionValidationError(
          'The staged ingestion records are incomplete or out of order.'
        );
      }
      const now = new Date();
      const [completed] = await tx
        .update(ingestionBatches)
        .set({ finishedAt: now, status: 'succeeded', updatedAt: now })
        .where(
          and(
            eq(ingestionBatches.id, record.batch.id),
            eq(ingestionBatches.status, 'running')
          )
        )
        .returning();
      if (!completed) {
        throw new SqliteIngestionConflictError(
          'The ingestion batch is no longer running.'
        );
      }
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
      return { done: true, summary: toSqliteBatchSummary(completed) };
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
      existingColumns.filter(({ kind }) => kind === 'input').map(({ id }) => id)
    );
    const mapping: Array<{ columnId: string; field: string }> = [
      ...(record.endpoint.fieldMapping ?? []).filter(({ columnId }) =>
        inputColumnIds.has(columnId)
      ),
    ];
    const mappedFields = new Set(
      mapping.map(({ field }) => normalizeField(field))
    );
    const newFields = record.batch.fields.filter(
      (field) => !mappedFields.has(normalizeField(field))
    );
    if (mapping.length + newFields.length > 100) {
      throw new SqliteIngestionValidationError(
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
        if (!created) {
          throw new Error('An ingestion column could not be created.');
        }
        columnId = created.id;
      }
      mapping.push({ columnId, field: plan.header });
    }

    const keys = staged.map(({ recordKey }) => recordKey);
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
      ({ recordKey }) => !identityByKey.has(recordKey)
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
      ({ recordKey }) => identityByKey.get(recordKey)!.rowId
    );
    const mappedColumnIds = mapping.map(({ columnId }) => columnId);
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
                  searchText: decision.value,
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
        const changedColumnIds = changedColumnIdsForRecord(item);
        if (changedColumnIds.length === 0) continue;
        const rowId = identityByKey.get(item.recordKey)!.rowId;
        const changedFormulaIds = await recomputeDependentSqliteFormulasForRow(
          tx,
          {
            changedColumnIds,
            rowId,
            tableId: input.tableId,
            workspaceId: input.workspaceId,
          }
        );
        await recordSqliteRowMutationAndMaybeQueueSettlement(tx, {
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
      .where(
        and(
          eq(ingestionBatches.id, record.batch.id),
          eq(ingestionBatches.status, 'running')
        )
      )
      .returning();
    if (!updated) {
      throw new SqliteIngestionConflictError(
        'The ingestion batch is no longer running.'
      );
    }
    await tx
      .update(ingestionEndpoints)
      .set({
        fieldMapping: mapping satisfies SourceFieldMapping,
        updatedAt: new Date(),
      })
      .where(eq(ingestionEndpoints.id, record.endpoint.id));
    return { done: false, summary: toSqliteBatchSummary(updated) };
  });
}

export async function setSqliteIngestionBatchWorkerFailure(
  db: SqliteDatabase,
  rawInput: IngestionBatchInput & {
    errorMessage: string;
    retrying: boolean;
  }
): Promise<void> {
  const input = ingestionBatchInputSchema.parse({
    batchId: rawInput.batchId,
    endpointId: rawInput.endpointId,
    tableId: rawInput.tableId,
    workspaceId: rawInput.workspaceId,
  });
  await db
    .update(ingestionBatches)
    .set({
      errorMessage: safeError(rawInput.errorMessage),
      finishedAt: rawInput.retrying ? null : new Date(),
      status: rawInput.retrying ? 'queued' : 'failed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(ingestionBatches.id, input.batchId),
        eq(ingestionBatches.endpointId, input.endpointId),
        eq(ingestionBatches.tableId, input.tableId),
        eq(ingestionBatches.workspaceId, input.workspaceId),
        inArray(ingestionBatches.status, ['queued', 'running'])
      )
    );
}

async function requireSqliteIngestionMember(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  input: SqliteIngestionScope
): Promise<void> {
  const [member] = await db
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
  if (!member) {
    throw new SqliteIngestionAccessError('The table is not accessible.');
  }
}

async function requireSqliteIngestionAdmin(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  input: SqliteIngestionScope
): Promise<void> {
  const [member] = await db
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
  if (!member) {
    throw new SqliteIngestionAccessError(
      'Only workspace owners and admins can manage ingestion endpoints.'
    );
  }
}

function normalizeField(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}

function safeError(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

function toSqliteBatchSummary(
  batch: typeof ingestionBatches.$inferSelect
): SqliteIngestionBatchSummary {
  return {
    createdRowCount: batch.createdRowCount,
    errorMessage: batch.errorMessage,
    id: batch.id,
    recordCount: batch.recordCount,
    status: batch.status,
    updatedRowCount: batch.updatedRowCount,
  };
}

function toSqliteEndpointSummary(
  endpoint: typeof ingestionEndpoints.$inferSelect,
  lastBatch: SqliteIngestionBatchSummary | null
): SqliteIngestionEndpointSummary {
  return {
    id: endpoint.id,
    lastBatch,
    name: endpoint.name,
    recordKeyField: endpoint.recordKeyField,
    revokedAt: endpoint.revokedAt,
    tokenPrefix: endpoint.tokenPrefix,
  };
}
