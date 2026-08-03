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
import type { Database } from './client';
import { recomputeDependentFormulasForRow } from './formulas';
import { recordRowMutationAndMaybeQueueSettlement } from './row-automations';
import { lockTableCellSchemaShared } from './schema-locks';
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
  workspaceMembers,
  type SourceFieldMapping,
} from './schema';

export class SourceAccessError extends Error {}
export class SourceConflictError extends Error {}
export class SourceValidationError extends Error {}

interface SourceScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface SourceRunSummary {
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

export interface SourceSummary {
  adapterId: 'http_json' | 'hubspot_contacts';
  credentialId: string | null;
  endpointUrl: string;
  id: string;
  incrementalWatermark: Date | null;
  lastRun: SourceRunSummary | null;
  maxRecords: number;
  missingRecordMode: (typeof sourceDefinitions.$inferSelect)['missingRecordMode'];
  pagination:
    | { mode: 'none' }
    | {
        cursorParameter: string;
        maxPages: number;
        mode: 'cursor';
        nextCursorPath: string;
      };
  name: string;
  nextRunAt: Date | null;
  recordKeyField: string;
  recordPath: string;
  scheduleIntervalMinutes: number | null;
  status: (typeof sourceDefinitions.$inferSelect)['status'];
  hubSpot: {
    initialSyncFrom: string;
    properties: readonly string[];
  } | null;
}

export async function createHttpJsonSource(
  db: Database,
  input: SourceScope &
    Omit<HttpJsonSourceRequest, 'missingRecordMode'> & {
      missingRecordMode?: SourceMissingRecordMode;
    }
): Promise<SourceSummary> {
  const intervalMinutes = scheduleIntervalMinutes(input.schedule);
  const now = new Date();
  const url = new URL(input.url);

  return db.transaction(async (tx) => {
    await assertSourceTableAccess(tx as unknown as Database, input);
    if (input.credentialId) {
      const [credential] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.id, input.credentialId),
            eq(credentials.workspaceId, input.workspaceId),
            eq(credentials.connectorId, 'http'),
            isNull(credentials.revokedAt)
          )
        )
        .limit(1);
      if (!credential) {
        throw new SourceValidationError(
          'The selected HTTP credential is missing or revoked.'
        );
      }
    }

    const [created] = await tx
      .insert(sourceDefinitions)
      .values({
        createdByUserId: input.userId,
        credentialId: input.credentialId,
        endpointUrl: url.toString(),
        maxRecords: input.maxRecords,
        missingRecordMode: input.missingRecordMode ?? 'preserve',
        cursorParameter:
          input.pagination.mode === 'cursor'
            ? input.pagination.cursorParameter
            : null,
        maxPages:
          input.pagination.mode === 'cursor' ? input.pagination.maxPages : 1,
        name: input.name,
        nextCursorPath:
          input.pagination.mode === 'cursor'
            ? input.pagination.nextCursorPath
            : null,
        nextRunAt: intervalMinutes
          ? new Date(now.getTime() + intervalMinutes * 60_000)
          : null,
        recordKeyField: input.recordKeyField,
        recordPath: input.recordPath,
        paginationMode: input.pagination.mode,
        scheduleIntervalMinutes: intervalMinutes,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created) throw new Error('The source could not be created.');
    return toSourceSummary(created, null);
  });
}

export async function createHubSpotContactsSource(
  db: Database,
  input: SourceScope & HubSpotContactsSourceRequest
): Promise<SourceSummary> {
  const request = hubSpotContactsSourceRequestSchema.parse({
    credentialId: input.credentialId,
    initialSyncFrom: input.initialSyncFrom,
    maxPages: input.maxPages,
    maxRecords: input.maxRecords,
    name: input.name,
    properties: input.properties,
    schedule: input.schedule,
  });
  const intervalMinutes = scheduleIntervalMinutes(request.schedule);
  const now = new Date();
  const initialSyncFrom = new Date(request.initialSyncFrom);
  if (
    initialSyncFrom.getTime() >=
    now.getTime() - HUBSPOT_INCREMENTAL_SAFETY_LAG_MS
  ) {
    throw new SourceValidationError(
      'The initial HubSpot sync time must be at least five minutes in the past.'
    );
  }
  return db.transaction(async (tx) => {
    await assertSourceTableAccess(tx as unknown as Database, input);
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
      throw new SourceValidationError(
        'The selected HubSpot credential is missing or revoked.'
      );
    }
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
    return toSourceSummary(created, null);
  });
}

export async function listSources(
  db: Database,
  input: SourceScope
): Promise<SourceSummary[]> {
  await assertSourceTableAccess(db, input);
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
    .orderBy(desc(sourceDefinitions.createdAt))
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
    .orderBy(desc(sourceRuns.createdAt))
    .limit(100);
  const lastRunBySource = new Map<string, SourceRunSummary>();
  for (const run of recentRuns) {
    if (!lastRunBySource.has(run.sourceId)) {
      lastRunBySource.set(run.sourceId, toSourceRunSummary(run));
    }
  }
  return definitions.map(({ source }) =>
    toSourceSummary(source, lastRunBySource.get(source.id) ?? null)
  );
}

export async function setSourceStatus(
  db: Database,
  input: SourceScope & {
    sourceId: string;
    status: 'active' | 'paused';
  }
): Promise<SourceSummary> {
  return db.transaction(async (tx) => {
    await assertSourceTableAccess(tx as unknown as Database, input);
    const [record] = await tx
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
      .limit(1)
      .for('update', { of: sourceDefinitions });
    if (!record) throw new SourceAccessError('The source is not accessible.');
    if (input.status === 'active' && record.source.fieldMapping?.length) {
      const mappedColumnIds = [
        ...new Set(
          record.source.fieldMapping.map((mapping) => mapping.columnId)
        ),
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
        throw new SourceConflictError(
          'Restore every mapped column before resuming this source.'
        );
      }
    }
    const [updated] = await tx
      .update(sourceDefinitions)
      .set({
        nextRunAt:
          input.status === 'active' && record.source.scheduleIntervalMinutes
            ? new Date()
            : null,
        status: input.status,
        updatedAt: new Date(),
      })
      .where(eq(sourceDefinitions.id, record.source.id))
      .returning();
    if (!updated) throw new Error('The source could not be updated.');
    return toSourceSummary(updated, null);
  });
}

export async function queueManualSourceRun(
  db: Database,
  input: SourceScope & { sourceId: string }
): Promise<SourceRunSummary> {
  return db.transaction(async (tx) => {
    await assertSourceTableAccess(tx as unknown as Database, input);
    const [record] = await tx
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
      .limit(1)
      .for('update', { of: sourceDefinitions });
    if (!record) throw new SourceAccessError('The source is not accessible.');
    if (record.source.status !== 'active') {
      throw new SourceConflictError('Resume the source before running it.');
    }
    await assertNoActiveSourceRun(tx as unknown as Database, record.source.id);
    const scheduledFor = new Date();
    const incrementalWindow = sourceIncrementalWindow(
      record.source,
      scheduledFor
    );
    const [run] = await tx
      .insert(sourceRuns)
      .values({
        ...incrementalWindow,
        scheduledFor,
        sourceId: record.source.id,
        tableId: record.source.tableId,
        trigger: 'manual',
        workspaceId: record.source.workspaceId,
      })
      .returning();
    if (!run) throw new Error('The source run could not be created.');
    await enqueueSourceRun(tx as unknown as Database, run);
    return toSourceRunSummary(run);
  });
}

export async function queueDueSourceRuns(
  db: Database,
  now = new Date(),
  limit = 25
): Promise<number> {
  return db.transaction(async (tx) => {
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
      .orderBy(asc(sourceDefinitions.nextRunAt))
      .limit(Math.max(1, Math.min(limit, 100)))
      .for('update', { skipLocked: true });

    let queued = 0;
    for (const source of dueSources) {
      if (!source.nextRunAt || !source.scheduleIntervalMinutes) continue;
      const scheduledFor = source.nextRunAt;
      const nextRunAt = nextScheduledSourceRun(
        scheduledFor,
        source.scheduleIntervalMinutes,
        now
      );
      await tx
        .update(sourceDefinitions)
        .set({ nextRunAt, updatedAt: now })
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
      await enqueueSourceRun(tx as unknown as Database, run);
      queued += 1;
    }
    return queued;
  });
}

export async function applySourceRunPage(
  db: Database,
  input: {
    batch: NormalizedSourceBatch;
    expectedPage: number;
    nextCursorEncrypted: CryptoEnvelope | null;
    sourceId: string;
    sourceRunId: string;
    tableId: string;
    workspaceId: string;
  }
): Promise<SourceRunSummary> {
  return db.transaction(async (tx) => {
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
      .limit(1)
      .for('update', { of: sourceRuns });
    if (!record) throw new SourceAccessError('The source run does not exist.');
    if (record.run.status === 'succeeded')
      return toSourceRunSummary(record.run);
    if (record.run.status !== 'running') {
      throw new SourceConflictError(
        `The source run cannot apply from status ${record.run.status}.`
      );
    }
    await lockTableCellSchemaShared(tx, input);
    if (
      !Number.isInteger(input.expectedPage) ||
      input.expectedPage < 1 ||
      input.expectedPage > record.source.maxPages
    ) {
      throw new SourceValidationError('The source page number is invalid.');
    }
    if (record.run.pageCount >= input.expectedPage) {
      return toSourceRunSummary(record.run);
    }
    if (record.run.pageCount + 1 !== input.expectedPage) {
      throw new SourceConflictError('The source page checkpoint is stale.');
    }
    if (
      record.run.receivedRecordCount + input.batch.records.length >
      record.source.maxRecords
    ) {
      throw new SourceValidationError(
        'The source run exceeds its total record limit.'
      );
    }
    if (
      record.source.paginationMode === 'none' &&
      input.nextCursorEncrypted !== null
    ) {
      throw new SourceValidationError(
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
      throw new SourceValidationError(
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
      throw new SourceValidationError(
        'The source repeated a record key across pages in one run.'
      );
    }
    const identitiesToRestore = identities.filter(
      (identity) => identity.archivedAt !== null
    );
    if (identitiesToRestore.length > 0) {
      const rowIds = identitiesToRestore.map((identity) => identity.rowId);
      await tx
        .update(rows)
        .set({
          archivedAt: null,
          updatedAt: new Date(),
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
        .set({ archivedAt: null, archivedByRunId: null, updatedAt: new Date() })
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
    if (newRecords.length > 0) {
      const rowDefinitions = newRecords.map((item, index) => ({
        key: item.key,
        position: `${record.run.scheduledFor.getTime().toString().padStart(13, '0')}-${record.run.id}-${String(input.expectedPage).padStart(4, '0')}-${String(index).padStart(6, '0')}`,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      }));
      const createdRows = await tx
        .insert(rows)
        .values(
          rowDefinitions.map(({ key: _key, ...rowDefinition }) => rowDefinition)
        )
        .returning({ id: rows.id, position: rows.position });
      const rowIdByPosition = new Map(
        createdRows.map((row) => [row.position, row.id])
      );
      const identitiesToCreate = rowDefinitions.map((definition) => ({
        lastSeenRunId: input.sourceRunId,
        recordKey: definition.key,
        rowId: rowIdByPosition.get(definition.position)!,
        sourceId: input.sourceId,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      }));
      await tx.insert(sourceRecords).values(identitiesToCreate);
      for (const identity of identitiesToCreate) {
        identityByKey.set(identity.recordKey, {
          ...identity,
          archivedAt: null,
          archivedByRunId: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
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
        const changedFormulaIds = await recomputeDependentFormulasForRow(tx, {
          changedColumnIds: mappedColumnIds,
          rowId,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        });
        await recordRowMutationAndMaybeQueueSettlement(tx, {
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
        )
        .for('update');
      const missingRowIds = missingIdentities.map((identity) => identity.rowId);
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
      .where(eq(sourceRuns.id, input.sourceRunId))
      .returning();
    if (!updatedRun) throw new Error('The source page could not be applied.');
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
          sourceId: input.sourceId,
          sourceRunId: input.sourceRunId,
          tableId: input.tableId,
          restoredRowCount,
          updatedRowCount,
        },
        workspaceId: input.workspaceId,
      });
    }
    return toSourceRunSummary(updatedRun);
  });
}

export async function applySourceRunBatch(
  db: Database,
  input: {
    batch: NormalizedSourceBatch;
    sourceId: string;
    sourceRunId: string;
    tableId: string;
    workspaceId: string;
  }
): Promise<SourceRunSummary> {
  return applySourceRunPage(db, {
    ...input,
    expectedPage: 1,
    nextCursorEncrypted: null,
  });
}

export async function markSourceRunRunning(
  db: Database,
  input: {
    sourceId: string;
    sourceRunId: string;
    workspaceId: string;
  }
): Promise<'ready' | 'succeeded' | 'cancelled'> {
  return db.transaction(async (tx) => {
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
      .limit(1)
      .for('update');
    if (!run) throw new SourceAccessError('The source run does not exist.');
    if (run.status === 'succeeded') return 'succeeded';
    if (run.status === 'cancelled') return 'cancelled';
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new SourceConflictError(
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
      .where(eq(sourceRuns.id, run.id));
    return 'ready';
  });
}

export async function setSourceRunWorkerFailure(
  db: Database,
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
      errorMessage: safeErrorMessage(input.errorMessage),
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

export async function assertSourceTableAccess(
  db: Database,
  input: SourceScope
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
  if (!table) throw new SourceAccessError('The table is not accessible.');
}

function assertNoActiveSourceRun(
  db: Database,
  sourceId: string
): Promise<void> {
  return db
    .select({ id: sourceRuns.id })
    .from(sourceRuns)
    .where(
      and(
        eq(sourceRuns.sourceId, sourceId),
        inArray(sourceRuns.status, ['queued', 'running'])
      )
    )
    .limit(1)
    .then(([run]) => {
      if (run)
        throw new SourceConflictError('This source already has an active run.');
    });
}

async function enqueueSourceRun(
  db: Database,
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

function toSourceSummary(
  source: typeof sourceDefinitions.$inferSelect,
  lastRun: SourceRunSummary | null
): SourceSummary {
  const hubSpot =
    source.adapterId === 'hubspot_contacts'
      ? hubSpotContactsSourceConfigurationSchema.parse(
          source.adapterConfiguration
        )
      : null;
  return {
    adapterId: source.adapterId as SourceSummary['adapterId'],
    credentialId: source.credentialId,
    endpointUrl: source.endpointUrl,
    id: source.id,
    incrementalWatermark: source.incrementalWatermark,
    lastRun,
    maxRecords: source.maxRecords,
    missingRecordMode: source.missingRecordMode,
    name: source.name,
    nextRunAt: source.nextRunAt,
    recordKeyField: source.recordKeyField,
    recordPath: source.recordPath,
    pagination:
      source.paginationMode === 'cursor'
        ? {
            cursorParameter: source.cursorParameter!,
            maxPages: source.maxPages,
            mode: 'cursor',
            nextCursorPath: source.nextCursorPath!,
          }
        : { mode: 'none' },
    scheduleIntervalMinutes: source.scheduleIntervalMinutes,
    status: source.status,
    hubSpot,
  };
}

function toSourceRunSummary(
  run: typeof sourceRuns.$inferSelect
): SourceRunSummary {
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
): {
  incrementalWindowEnd?: Date;
  incrementalWindowStart?: Date;
} {
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
    throw new SourceConflictError(
      'The HubSpot incremental window has not advanced yet.'
    );
  }
  return {
    incrementalWindowEnd: windowEnd,
    incrementalWindowStart: windowStart,
  };
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

function normalizeSourceField(field: string): string {
  return field.trim().normalize('NFKC').toLocaleLowerCase('en-US');
}
