import {
  HUBSPOT_CONTACT_ID_FIELD,
  HUBSPOT_INCREMENTAL_SAFETY_LAG_MS,
  hubSpotContactsSourceConfigurationSchema,
  hubSpotContactsSourceRequestSchema,
  nextScheduledSourceRun,
  planCsvColumns,
  scheduleIntervalMinutes,
  shouldArchiveMissingSourceRecords,
  type HttpJsonSourceRequest,
  type HubSpotContactsSourceRequest,
  type NormalizedSourceBatch,
  type SourceMissingRecordMode,
} from '@byok-grid/domain';
import type { CryptoEnvelope } from '@byok-grid/security';
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';
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
  credentials,
  dataTables,
  outboxEvents,
  rows,
  sourceDefinitions,
  sourceRecords,
  sourceRuns,
  workspaceKeys,
  workspaceMembers,
  type SourceFieldMapping,
} from './schema';

export class SqliteSourceAccessError extends Error {}
export class SqliteSourceConflictError extends Error {}
export class SqliteSourceValidationError extends Error {}

interface SqliteSourceScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface SqliteSourceRunSummary {
  archivedRowCount: number;
  createdRowCount: number;
  errorMessage: string | null;
  finishedAt: Date | null;
  id: string;
  incrementalWindowEnd: Date | null;
  incrementalWindowStart: Date | null;
  pageCount: number;
  receivedRecordCount: number;
  restoredRowCount: number;
  scheduledFor: Date;
  status: (typeof sourceRuns.$inferSelect)['status'];
  trigger: (typeof sourceRuns.$inferSelect)['trigger'];
  updatedRowCount: number;
}

export interface SqliteSourceSummary {
  adapterId: 'http_json' | 'hubspot_contacts';
  credentialId: string | null;
  endpointUrl: string;
  hubSpot: {
    initialSyncFrom: string;
    properties: readonly string[];
  } | null;
  id: string;
  incrementalWatermark: Date | null;
  lastRun: SqliteSourceRunSummary | null;
  maxRecords: number;
  missingRecordMode: (typeof sourceDefinitions.$inferSelect)['missingRecordMode'];
  name: string;
  nextRunAt: Date | null;
  pagination:
    | { mode: 'none' }
    | {
        cursorParameter: string;
        maxPages: number;
        mode: 'cursor';
        nextCursorPath: string;
      };
  recordKeyField: string;
  recordPath: string;
  scheduleIntervalMinutes: number | null;
  status: (typeof sourceDefinitions.$inferSelect)['status'];
}

export interface SqliteSourceRunExecution {
  credential: typeof credentials.$inferSelect | null;
  run: typeof sourceRuns.$inferSelect;
  source: typeof sourceDefinitions.$inferSelect;
  workspaceKey: typeof workspaceKeys.$inferSelect | null;
}

export async function createSqliteHttpJsonSource(
  db: SqliteDatabase,
  input: SqliteSourceScope &
    Omit<HttpJsonSourceRequest, 'missingRecordMode'> & {
      missingRecordMode?: SourceMissingRecordMode;
    }
): Promise<SqliteSourceSummary> {
  const intervalMinutes = scheduleIntervalMinutes(input.schedule);
  const now = new Date();
  const url = new URL(input.url);

  return withSqliteWriteTransaction(db, async (tx) => {
    await assertSqliteSourceTableAccess(tx, input);
    if (input.credentialId) {
      await requireActiveSourceCredential(
        tx,
        input.workspaceId,
        input.credentialId,
        'http'
      );
    }
    const [created] = await tx
      .insert(sourceDefinitions)
      .values({
        createdByUserId: input.userId,
        credentialId: input.credentialId,
        cursorParameter:
          input.pagination.mode === 'cursor'
            ? input.pagination.cursorParameter
            : null,
        endpointUrl: url.toString(),
        maxPages:
          input.pagination.mode === 'cursor' ? input.pagination.maxPages : 1,
        maxRecords: input.maxRecords,
        missingRecordMode: input.missingRecordMode ?? 'preserve',
        name: input.name,
        nextCursorPath:
          input.pagination.mode === 'cursor'
            ? input.pagination.nextCursorPath
            : null,
        nextRunAt: intervalMinutes
          ? new Date(now.getTime() + intervalMinutes * 60_000)
          : null,
        paginationMode: input.pagination.mode,
        recordKeyField: input.recordKeyField,
        recordPath: input.recordPath,
        scheduleIntervalMinutes: intervalMinutes,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created) throw new Error('The source could not be created.');
    return toSqliteSourceSummary(created, null);
  });
}

export async function createSqliteHubSpotContactsSource(
  db: SqliteDatabase,
  input: SqliteSourceScope & HubSpotContactsSourceRequest
): Promise<SqliteSourceSummary> {
  const request = hubSpotContactsSourceRequestSchema.parse(input);
  const intervalMinutes = scheduleIntervalMinutes(request.schedule);
  const now = new Date();
  const initialSyncFrom = new Date(request.initialSyncFrom);
  if (
    initialSyncFrom.getTime() >=
    now.getTime() - HUBSPOT_INCREMENTAL_SAFETY_LAG_MS
  ) {
    throw new SqliteSourceValidationError(
      'The initial HubSpot sync time must be at least five minutes in the past.'
    );
  }

  return withSqliteWriteTransaction(db, async (tx) => {
    await assertSqliteSourceTableAccess(tx, input);
    await requireActiveSourceCredential(
      tx,
      input.workspaceId,
      request.credentialId,
      'hubspot'
    );
    const [created] = await tx
      .insert(sourceDefinitions)
      .values({
        adapterConfiguration: {
          initialSyncFrom: initialSyncFrom.toISOString(),
          properties: request.properties,
        },
        adapterId: 'hubspot_contacts',
        createdByUserId: input.userId,
        credentialId: request.credentialId,
        cursorParameter: 'after',
        endpointUrl:
          'https://api.hubapi.com/crm/objects/2026-03/contacts/search',
        maxPages: request.maxPages,
        maxRecords: request.maxRecords,
        missingRecordMode: 'preserve',
        name: request.name,
        nextCursorPath: 'paging.next.after',
        nextRunAt: intervalMinutes
          ? new Date(now.getTime() + intervalMinutes * 60_000)
          : null,
        paginationMode: 'cursor',
        recordKeyField: HUBSPOT_CONTACT_ID_FIELD,
        recordPath: 'results',
        scheduleIntervalMinutes: intervalMinutes,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created) throw new Error('The HubSpot source could not be created.');
    return toSqliteSourceSummary(created, null);
  });
}

export async function listSqliteSources(
  db: SqliteDatabase,
  input: SqliteSourceScope
): Promise<SqliteSourceSummary[]> {
  await assertSqliteSourceTableAccess(db, input);
  const definitions = await db
    .select({ source: sourceDefinitions })
    .from(sourceDefinitions)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, sourceDefinitions.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(sourceDefinitions.tableId, input.tableId),
        eq(sourceDefinitions.workspaceId, input.workspaceId)
      )
    )
    .orderBy(desc(sourceDefinitions.createdAt), desc(sourceDefinitions.id))
    .limit(20);
  if (definitions.length === 0) return [];

  const recentRuns = await db
    .select()
    .from(sourceRuns)
    .where(
      and(
        eq(sourceRuns.workspaceId, input.workspaceId),
        inArray(
          sourceRuns.sourceId,
          definitions.map(({ source }) => source.id)
        )
      )
    )
    .orderBy(desc(sourceRuns.createdAt), desc(sourceRuns.id))
    .limit(100);
  const lastRunBySource = new Map<string, SqliteSourceRunSummary>();
  for (const run of recentRuns) {
    if (!lastRunBySource.has(run.sourceId)) {
      lastRunBySource.set(run.sourceId, toSqliteSourceRunSummary(run));
    }
  }
  return definitions.map(({ source }) =>
    toSqliteSourceSummary(source, lastRunBySource.get(source.id) ?? null)
  );
}

export async function setSqliteSourceStatus(
  db: SqliteDatabase,
  input: SqliteSourceScope & {
    sourceId: string;
    status: 'active' | 'paused';
  }
): Promise<SqliteSourceSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await assertSqliteSourceTableAccess(tx, input);
    const source = await requireAccessibleSource(tx, input);
    if (input.status === 'active' && source.fieldMapping?.length) {
      const mappedColumnIds = [
        ...new Set(source.fieldMapping.map((mapping) => mapping.columnId)),
      ];
      const activeColumns = await tx
        .select({ id: columns.id })
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
        throw new SqliteSourceConflictError(
          'Restore every mapped column before resuming this source.'
        );
      }
    }
    const [updated] = await tx
      .update(sourceDefinitions)
      .set({
        nextRunAt:
          input.status === 'active' && source.scheduleIntervalMinutes
            ? new Date()
            : null,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(sourceDefinitions.id, source.id))
      .returning();
    if (!updated) throw new Error('The source could not be updated.');
    return toSqliteSourceSummary(updated, null);
  });
}

export async function queueSqliteManualSourceRun(
  db: SqliteDatabase,
  input: SqliteSourceScope & { sourceId: string }
): Promise<SqliteSourceRunSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await assertSqliteSourceTableAccess(tx, input);
    const source = await requireAccessibleSource(tx, input);
    if (source.status !== 'active') {
      throw new SqliteSourceConflictError(
        'Resume the source before running it.'
      );
    }
    await assertNoActiveSqliteSourceRun(tx, source.id);
    const scheduledFor = new Date();
    const [run] = await tx
      .insert(sourceRuns)
      .values({
        ...sourceIncrementalWindow(source, scheduledFor),
        scheduledFor,
        sourceId: source.id,
        tableId: source.tableId,
        trigger: 'manual',
        workspaceId: source.workspaceId,
      })
      .returning();
    if (!run) throw new Error('The source run could not be created.');
    await enqueueSqliteSourceRun(tx, run);
    return toSqliteSourceRunSummary(run);
  });
}

export async function queueDueSqliteSourceRuns(
  db: SqliteDatabase,
  now = new Date(),
  limit = 25
): Promise<number> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const dueSources = await tx
      .select()
      .from(sourceDefinitions)
      .where(
        and(
          eq(sourceDefinitions.status, 'active'),
          isNotNull(sourceDefinitions.nextRunAt),
          lte(sourceDefinitions.nextRunAt, now)
        )
      )
      .orderBy(asc(sourceDefinitions.nextRunAt), asc(sourceDefinitions.id))
      .limit(Math.max(1, Math.min(Math.trunc(limit), 100)));

    let queued = 0;
    for (const source of dueSources) {
      if (!source.nextRunAt || !source.scheduleIntervalMinutes) continue;
      const scheduledFor = source.nextRunAt;
      await tx
        .update(sourceDefinitions)
        .set({
          nextRunAt: nextScheduledSourceRun(
            scheduledFor,
            source.scheduleIntervalMinutes,
            now
          ),
          updatedAt: now,
        })
        .where(eq(sourceDefinitions.id, source.id));

      const [activeRun] = await tx
        .select({ id: sourceRuns.id })
        .from(sourceRuns)
        .where(
          and(
            eq(sourceRuns.sourceId, source.id),
            inArray(sourceRuns.status, ['queued', 'running'])
          )
        )
        .limit(1);
      if (activeRun) continue;

      const [run] = await tx
        .insert(sourceRuns)
        .values({
          ...sourceIncrementalWindow(source, now),
          scheduledFor,
          sourceId: source.id,
          tableId: source.tableId,
          trigger: 'schedule',
          workspaceId: source.workspaceId,
        })
        .onConflictDoNothing({
          target: [sourceRuns.sourceId, sourceRuns.scheduledFor],
        })
        .returning();
      if (!run) continue;
      await enqueueSqliteSourceRun(tx, run);
      queued += 1;
    }
    return queued;
  });
}

export async function loadSqliteSourceRunExecution(
  db: SqliteDatabase,
  input: {
    sourceId: string;
    sourceRunId: string;
    tableId: string;
    workspaceId: string;
  }
): Promise<SqliteSourceRunExecution> {
  const [execution] = await db
    .select({
      credential: credentials,
      run: sourceRuns,
      source: sourceDefinitions,
      workspaceKey: workspaceKeys,
    })
    .from(sourceRuns)
    .innerJoin(
      sourceDefinitions,
      and(
        eq(sourceDefinitions.id, sourceRuns.sourceId),
        eq(sourceDefinitions.workspaceId, sourceRuns.workspaceId)
      )
    )
    .leftJoin(credentials, eq(credentials.id, sourceDefinitions.credentialId))
    .leftJoin(
      workspaceKeys,
      eq(workspaceKeys.workspaceId, sourceRuns.workspaceId)
    )
    .where(
      and(
        eq(sourceRuns.id, input.sourceRunId),
        eq(sourceRuns.sourceId, input.sourceId),
        eq(sourceRuns.tableId, input.tableId),
        eq(sourceRuns.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!execution) {
    throw new SqliteSourceAccessError('The source run does not exist.');
  }
  return execution;
}

export async function markSqliteSourceCredentialUsed(
  db: SqliteDatabase,
  input: { credentialId: string; workspaceId: string }
): Promise<void> {
  await db
    .update(credentials)
    .set({ lastUsedAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(credentials.id, input.credentialId),
        eq(credentials.workspaceId, input.workspaceId)
      )
    );
}

export async function markSqliteSourceRunRunning(
  db: SqliteDatabase,
  input: {
    sourceId: string;
    sourceRunId: string;
    workspaceId: string;
  }
): Promise<'ready' | 'succeeded' | 'cancelled'> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [run] = await tx
      .select()
      .from(sourceRuns)
      .where(
        and(
          eq(sourceRuns.id, input.sourceRunId),
          eq(sourceRuns.sourceId, input.sourceId),
          eq(sourceRuns.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!run)
      throw new SqliteSourceAccessError('The source run does not exist.');
    if (run.status === 'succeeded') return 'succeeded';
    if (run.status === 'cancelled') return 'cancelled';
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new SqliteSourceConflictError(
        `The source run cannot start from status ${run.status}.`
      );
    }
    await tx
      .update(sourceRuns)
      .set({
        attempt: run.attempt + 1,
        errorCode: null,
        errorMessage: null,
        startedAt: run.startedAt ?? new Date(),
        status: 'running',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sourceRuns.id, run.id),
          inArray(sourceRuns.status, ['queued', 'running'])
        )
      );
    return 'ready';
  });
}

export async function setSqliteSourceRunWorkerFailure(
  db: SqliteDatabase,
  input: {
    errorCode: string;
    errorMessage: string;
    retrying: boolean;
    sourceRunId: string;
    workspaceId: string;
  }
): Promise<void> {
  await db
    .update(sourceRuns)
    .set({
      errorCode: input.errorCode,
      errorMessage: safeSourceErrorMessage(input.errorMessage),
      finishedAt: input.retrying ? null : new Date(),
      status: input.retrying ? 'queued' : 'failed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sourceRuns.id, input.sourceRunId),
        eq(sourceRuns.workspaceId, input.workspaceId),
        inArray(sourceRuns.status, ['queued', 'running'])
      )
    );
}

export async function applySqliteSourceRunPage(
  db: SqliteDatabase,
  input: {
    batch: NormalizedSourceBatch;
    expectedPage: number;
    nextCursorEncrypted: CryptoEnvelope | null;
    sourceId: string;
    sourceRunId: string;
    tableId: string;
    workspaceId: string;
  }
): Promise<SqliteSourceRunSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [record] = await tx
      .select({ run: sourceRuns, source: sourceDefinitions })
      .from(sourceRuns)
      .innerJoin(
        sourceDefinitions,
        and(
          eq(sourceDefinitions.id, sourceRuns.sourceId),
          eq(sourceDefinitions.workspaceId, sourceRuns.workspaceId)
        )
      )
      .where(
        and(
          eq(sourceRuns.id, input.sourceRunId),
          eq(sourceRuns.sourceId, input.sourceId),
          eq(sourceRuns.tableId, input.tableId),
          eq(sourceRuns.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!record) {
      throw new SqliteSourceAccessError('The source run does not exist.');
    }
    if (record.run.status === 'succeeded') {
      return toSqliteSourceRunSummary(record.run);
    }
    if (record.run.status !== 'running') {
      throw new SqliteSourceConflictError(
        `The source run cannot apply from status ${record.run.status}.`
      );
    }
    if (
      !Number.isInteger(input.expectedPage) ||
      input.expectedPage < 1 ||
      input.expectedPage > record.source.maxPages
    ) {
      throw new SqliteSourceValidationError(
        'The source page number is invalid.'
      );
    }
    if (record.run.pageCount >= input.expectedPage) {
      return toSqliteSourceRunSummary(record.run);
    }
    if (record.run.pageCount + 1 !== input.expectedPage) {
      throw new SqliteSourceConflictError(
        'The source page checkpoint is stale.'
      );
    }
    if (
      record.run.receivedRecordCount + input.batch.records.length >
      record.source.maxRecords
    ) {
      throw new SqliteSourceValidationError(
        'The source run exceeds its total record limit.'
      );
    }
    if (
      record.source.paginationMode === 'none' &&
      input.nextCursorEncrypted !== null
    ) {
      throw new SqliteSourceValidationError(
        'A single-response source cannot store a pagination cursor.'
      );
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
      ...(record.source.fieldMapping ?? []).filter((item) =>
        inputColumnIds.has(item.columnId)
      ),
    ];
    const mappedFields = new Set(
      mapping.map((item) => normalizeSourceField(item.field))
    );
    const newFields = input.batch.fields.filter(
      (field) => !mappedFields.has(normalizeSourceField(field))
    );
    if (mapping.length + newFields.length > 100) {
      throw new SqliteSourceValidationError(
        'A source cannot map more than 100 fields across all pages.'
      );
    }
    const currentFieldByNormalized = new Map(
      input.batch.fields.map((field) => [normalizeSourceField(field), field])
    );
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
            position: `x-source-${record.source.id}-${String(mappingStart + index).padStart(4, '0')}`,
            tableId: input.tableId,
            valueType: 'text',
            workspaceId: input.workspaceId,
          })
          .returning({ id: columns.id });
        if (!created) throw new Error('A source column could not be created.');
        columnId = created.id;
      }
      mapping.push({ columnId, field: plan.header });
    }

    const recordKeys = input.batch.records.map((item) => item.key);
    const identities =
      recordKeys.length === 0
        ? []
        : await tx
            .select()
            .from(sourceRecords)
            .where(
              and(
                eq(sourceRecords.sourceId, input.sourceId),
                eq(sourceRecords.workspaceId, input.workspaceId),
                inArray(sourceRecords.recordKey, recordKeys)
              )
            );
    const identityByKey = new Map(
      identities.map((identity) => [identity.recordKey, identity])
    );
    if (
      identities.some(
        (identity) => identity.lastSeenRunId === input.sourceRunId
      )
    ) {
      throw new SqliteSourceValidationError(
        'The source repeated a record key across pages in one run.'
      );
    }
    const identitiesToRestore = identities.filter(
      (identity) => identity.archivedAt !== null
    );
    if (identitiesToRestore.length > 0) {
      const rowIds = identitiesToRestore.map((identity) => identity.rowId);
      const now = new Date();
      await tx
        .update(rows)
        .set({
          archivedAt: null,
          updatedAt: now,
          version: sql`${rows.version} + 1`,
        })
        .where(
          and(
            eq(rows.tableId, input.tableId),
            eq(rows.workspaceId, input.workspaceId),
            inArray(rows.id, rowIds)
          )
        );
      await tx
        .update(sourceRecords)
        .set({ archivedAt: null, archivedByRunId: null, updatedAt: now })
        .where(
          and(
            eq(sourceRecords.sourceId, input.sourceId),
            eq(sourceRecords.workspaceId, input.workspaceId),
            inArray(sourceRecords.rowId, rowIds)
          )
        );
    }

    const newRecords = input.batch.records.filter(
      (item) => !identityByKey.has(item.key)
    );
    for (let index = 0; index < newRecords.length; index += 1) {
      const item = newRecords[index]!;
      const [createdRow] = await tx
        .insert(rows)
        .values({
          position: `${record.run.scheduledFor.getTime().toString().padStart(13, '0')}-${record.run.id}-${String(input.expectedPage).padStart(4, '0')}-${String(index).padStart(6, '0')}`,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        })
        .returning({ id: rows.id });
      if (!createdRow) throw new Error('A source row could not be created.');
      const [identity] = await tx
        .insert(sourceRecords)
        .values({
          lastSeenRunId: input.sourceRunId,
          recordKey: item.key,
          rowId: createdRow.id,
          sourceId: input.sourceId,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        })
        .returning();
      if (!identity) throw new Error('A source identity could not be created.');
      identityByKey.set(item.key, identity);
    }

    const affectedRowIds = input.batch.records.map(
      (item) => identityByKey.get(item.key)!.rowId
    );
    const mappedColumnIds = mapping.map((item) => item.columnId);
    if (affectedRowIds.length > 0 && mappedColumnIds.length > 0) {
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
      const values = input.batch.records.flatMap((item) => {
        const rowId = identityByKey.get(item.key)!.rowId;
        return mapping.flatMap(({ columnId, field }) => {
          const currentField = currentFieldByNormalized.get(
            normalizeSourceField(field)
          );
          const value = currentField ? item.values[currentField] : undefined;
          return value === null || value === undefined || value === ''
            ? []
            : [
                {
                  columnId,
                  rowId,
                  searchText: value,
                  tableId: input.tableId,
                  valueText: value,
                  valueType: 'text' as const,
                  workspaceId: input.workspaceId,
                },
              ];
        });
      });
      if (values.length > 0) await tx.insert(cells).values(values);
      for (const rowId of affectedRowIds) {
        const changedFormulaIds = await recomputeDependentSqliteFormulasForRow(
          tx,
          {
            changedColumnIds: mappedColumnIds,
            rowId,
            tableId: input.tableId,
            workspaceId: input.workspaceId,
          }
        );
        await recordSqliteRowMutationAndMaybeQueueSettlement(tx, {
          changedColumnIds: [...mappedColumnIds, ...changedFormulaIds],
          rowId,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        });
      }
    }

    if (recordKeys.length > 0) {
      await tx
        .update(sourceRecords)
        .set({ lastSeenRunId: input.sourceRunId, updatedAt: new Date() })
        .where(
          and(
            eq(sourceRecords.sourceId, input.sourceId),
            eq(sourceRecords.workspaceId, input.workspaceId),
            inArray(sourceRecords.recordKey, recordKeys)
          )
        );
    }

    const completed = input.nextCursorEncrypted === null;
    const now = new Date();
    let archivedRowCount = record.run.archivedRowCount;
    if (
      shouldArchiveMissingSourceRecords({
        completed,
        mode: record.source.missingRecordMode,
      })
    ) {
      const missingIdentities = await tx
        .select({ rowId: sourceRecords.rowId })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.sourceId, input.sourceId),
            eq(sourceRecords.workspaceId, input.workspaceId),
            isNull(sourceRecords.archivedAt),
            or(
              isNull(sourceRecords.lastSeenRunId),
              ne(sourceRecords.lastSeenRunId, input.sourceRunId)
            )
          )
        );
      const missingRowIds = missingIdentities.map(({ rowId }) => rowId);
      if (missingRowIds.length > 0) {
        await tx
          .update(rows)
          .set({
            archivedAt: now,
            updatedAt: now,
            version: sql`${rows.version} + 1`,
          })
          .where(
            and(
              eq(rows.tableId, input.tableId),
              eq(rows.workspaceId, input.workspaceId),
              inArray(rows.id, missingRowIds),
              isNull(rows.archivedAt)
            )
          );
        await tx
          .update(sourceRecords)
          .set({
            archivedAt: now,
            archivedByRunId: input.sourceRunId,
            updatedAt: now,
          })
          .where(
            and(
              eq(sourceRecords.sourceId, input.sourceId),
              eq(sourceRecords.workspaceId, input.workspaceId),
              inArray(sourceRecords.rowId, missingRowIds),
              isNull(sourceRecords.archivedAt)
            )
          );
        archivedRowCount += missingRowIds.length;
      }
    }

    const createdRowCount = record.run.createdRowCount + newRecords.length;
    const receivedRecordCount =
      record.run.receivedRecordCount + input.batch.records.length;
    const updatedRowCount =
      record.run.updatedRowCount +
      input.batch.records.length -
      newRecords.length;
    const restoredRowCount =
      record.run.restoredRowCount + identitiesToRestore.length;
    await tx
      .update(sourceDefinitions)
      .set({
        fieldMapping: mapping satisfies SourceFieldMapping,
        incrementalWatermark:
          completed && record.source.adapterId === 'hubspot_contacts'
            ? record.run.incrementalWindowEnd
            : record.source.incrementalWatermark,
        lastRunAt: completed ? now : record.source.lastRunAt,
        updatedAt: now,
      })
      .where(eq(sourceDefinitions.id, input.sourceId));
    const [updatedRun] = await tx
      .update(sourceRuns)
      .set({
        archivedRowCount,
        createdRowCount,
        errorCode: null,
        errorMessage: null,
        finishedAt: completed ? now : null,
        nextCursorEncrypted: input.nextCursorEncrypted,
        pageCount: input.expectedPage,
        receivedRecordCount,
        restoredRowCount,
        status: completed ? 'succeeded' : 'running',
        updatedAt: now,
        updatedRowCount,
      })
      .where(
        and(
          eq(sourceRuns.id, input.sourceRunId),
          eq(sourceRuns.status, 'running'),
          eq(sourceRuns.pageCount, record.run.pageCount)
        )
      )
      .returning();
    if (!updatedRun) {
      throw new SqliteSourceConflictError(
        'The source page checkpoint changed during application.'
      );
    }
    if (completed) {
      await tx.insert(outboxEvents).values({
        aggregateId: input.sourceRunId,
        aggregateType: 'source_run',
        eventType: 'table.source_run_succeeded',
        payload: {
          archivedRowCount,
          createdRowCount,
          pageCount: input.expectedPage,
          receivedRecordCount,
          restoredRowCount,
          sourceId: input.sourceId,
          sourceRunId: input.sourceRunId,
          tableId: input.tableId,
          updatedRowCount,
        },
        workspaceId: input.workspaceId,
      });
    }
    return toSqliteSourceRunSummary(updatedRun);
  });
}

export async function applySqliteSourceRunBatch(
  db: SqliteDatabase,
  input: {
    batch: NormalizedSourceBatch;
    sourceId: string;
    sourceRunId: string;
    tableId: string;
    workspaceId: string;
  }
): Promise<SqliteSourceRunSummary> {
  return applySqliteSourceRunPage(db, {
    ...input,
    expectedPage: 1,
    nextCursorEncrypted: null,
  });
}

export async function assertSqliteSourceTableAccess(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  input: SqliteSourceScope
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
  if (!table) throw new SqliteSourceAccessError('The table is not accessible.');
}

async function requireAccessibleSource(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  input: SqliteSourceScope & { sourceId: string }
): Promise<typeof sourceDefinitions.$inferSelect> {
  const [source] = await db
    .select({ source: sourceDefinitions })
    .from(sourceDefinitions)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, sourceDefinitions.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(sourceDefinitions.id, input.sourceId),
        eq(sourceDefinitions.tableId, input.tableId),
        eq(sourceDefinitions.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!source) {
    throw new SqliteSourceAccessError('The source is not accessible.');
  }
  return source.source;
}

async function requireActiveSourceCredential(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  workspaceId: string,
  credentialId: string,
  connectorId: 'http' | 'hubspot'
): Promise<void> {
  const [credential] = await db
    .select({ id: credentials.id })
    .from(credentials)
    .where(
      and(
        eq(credentials.id, credentialId),
        eq(credentials.workspaceId, workspaceId),
        eq(credentials.connectorId, connectorId),
        isNull(credentials.revokedAt)
      )
    )
    .limit(1);
  if (!credential) {
    throw new SqliteSourceValidationError(
      `The selected ${connectorId === 'http' ? 'HTTP' : 'HubSpot'} credential is missing or revoked.`
    );
  }
}

async function assertNoActiveSqliteSourceRun(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  sourceId: string
): Promise<void> {
  const [run] = await db
    .select({ id: sourceRuns.id })
    .from(sourceRuns)
    .where(
      and(
        eq(sourceRuns.sourceId, sourceId),
        inArray(sourceRuns.status, ['queued', 'running'])
      )
    )
    .limit(1);
  if (run) {
    throw new SqliteSourceConflictError(
      'This source already has an active run.'
    );
  }
}

async function enqueueSqliteSourceRun(
  db: SqliteTransaction,
  run: typeof sourceRuns.$inferSelect
): Promise<void> {
  await db.insert(outboxEvents).values({
    aggregateId: run.id,
    aggregateType: 'source_run',
    eventType: 'table.source_run_requested',
    payload: {
      sourceId: run.sourceId,
      sourceRunId: run.id,
      tableId: run.tableId,
      workspaceId: run.workspaceId,
    },
    workspaceId: run.workspaceId,
  });
}

function toSqliteSourceSummary(
  source: typeof sourceDefinitions.$inferSelect,
  lastRun: SqliteSourceRunSummary | null
): SqliteSourceSummary {
  const hubSpot =
    source.adapterId === 'hubspot_contacts'
      ? hubSpotContactsSourceConfigurationSchema.parse(
          source.adapterConfiguration
        )
      : null;
  return {
    adapterId: source.adapterId as SqliteSourceSummary['adapterId'],
    credentialId: source.credentialId,
    endpointUrl: source.endpointUrl,
    hubSpot,
    id: source.id,
    incrementalWatermark: source.incrementalWatermark,
    lastRun,
    maxRecords: source.maxRecords,
    missingRecordMode: source.missingRecordMode,
    name: source.name,
    nextRunAt: source.nextRunAt,
    pagination:
      source.paginationMode === 'cursor'
        ? {
            cursorParameter: source.cursorParameter!,
            maxPages: source.maxPages,
            mode: 'cursor',
            nextCursorPath: source.nextCursorPath!,
          }
        : { mode: 'none' },
    recordKeyField: source.recordKeyField,
    recordPath: source.recordPath,
    scheduleIntervalMinutes: source.scheduleIntervalMinutes,
    status: source.status,
  };
}

function toSqliteSourceRunSummary(
  run: typeof sourceRuns.$inferSelect
): SqliteSourceRunSummary {
  return {
    archivedRowCount: run.archivedRowCount,
    createdRowCount: run.createdRowCount,
    errorMessage: run.errorMessage,
    finishedAt: run.finishedAt,
    id: run.id,
    incrementalWindowEnd: run.incrementalWindowEnd,
    incrementalWindowStart: run.incrementalWindowStart,
    pageCount: run.pageCount,
    receivedRecordCount: run.receivedRecordCount,
    restoredRowCount: run.restoredRowCount,
    scheduledFor: run.scheduledFor,
    status: run.status,
    trigger: run.trigger,
    updatedRowCount: run.updatedRowCount,
  };
}

function sourceIncrementalWindow(
  source: typeof sourceDefinitions.$inferSelect,
  observedAt: Date
): { incrementalWindowEnd?: Date; incrementalWindowStart?: Date } {
  if (source.adapterId !== 'hubspot_contacts') return {};
  const configuration = hubSpotContactsSourceConfigurationSchema.parse(
    source.adapterConfiguration
  );
  const windowStart =
    source.incrementalWatermark ?? new Date(configuration.initialSyncFrom);
  const windowEnd = new Date(
    observedAt.getTime() - HUBSPOT_INCREMENTAL_SAFETY_LAG_MS
  );
  if (windowStart.getTime() >= windowEnd.getTime()) {
    throw new SqliteSourceConflictError(
      'The HubSpot incremental window has not advanced yet.'
    );
  }
  return {
    incrementalWindowEnd: windowEnd,
    incrementalWindowStart: windowStart,
  };
}

function safeSourceErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

function normalizeSourceField(field: string): string {
  return field.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
