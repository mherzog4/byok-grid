import {
  bulkRunInputSchema,
  bulkRunModeSchema,
  bulkRunSelectionSnapshotSchema,
  canCancelBulkRun,
  connectorActionColumnConfigurationSchema,
  excludedBulkRunStatuses,
  gridSearchQuerySchema,
  MAXIMUM_CELL_RUN_ATTEMPTS,
  shouldSelectCellForBulkRun,
  type BulkRunInput,
  type BulkRunMode,
  type BulkRunSelectionSnapshot,
  type GridViewFilterGroup,
  type GridViewSort,
} from '@byok-grid/domain';
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  ne,
  notExists,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { createHash } from 'node:crypto';
import {
  type SqliteDatabase,
  type SqliteTransaction,
  withSqliteWriteTransaction,
} from './client';
import {
  queueSqliteEnrichmentCellRunInTransaction,
  SqliteEnrichmentAccessError,
  SqliteEnrichmentValidationError,
} from './enrichments';
import { buildSqliteGridSearchPredicate } from './grid';
import {
  buildSqliteGridViewFilterTreePredicate,
  sqliteGridViewSortExpressions,
  type SqliteGridSortableValueType,
} from './grid-view-query';
import { getSqliteSavedGridView } from './grid-views';
import {
  bulkRunBatches,
  bulkRunItems,
  cellRuns,
  cells,
  columns,
  dataTables,
  outboxEvents,
  rows,
  usageLedger,
  workspaceMembers,
} from './schema';

export class SqliteBulkRunConflictError extends Error {}

export interface SqliteBulkRunLimits {
  maxOutputTokens: number;
  maxProviderRequests: number;
  maxRows: number;
}

interface SqliteBulkRunScope {
  columnId: string;
  tableId: string;
  userId: string;
  workspaceId: string;
}

interface SqliteBulkRunPreviewInput extends SqliteBulkRunScope {
  limits: SqliteBulkRunLimits;
  mode: BulkRunMode;
  rowLimit: number;
  searchQuery?: string | null | undefined;
  viewId?: string | null | undefined;
}

export interface SqliteBulkRunPreview {
  column: { id: string; name: string };
  estimatedMaxOutputTokens: number | null;
  estimatedProviderRequests: number;
  excludedByModeRows: number;
  inputReadyRows: number;
  limitViolations: string[];
  limits: SqliteBulkRunLimits;
  mode: BulkRunMode;
  requestedRowLimit: number;
  scopedRows: number;
  selectedRows: number;
  selection: BulkRunSelectionSnapshot;
  selectionDigest: string;
  totalRows: number;
}

export async function previewSqliteBulkRun(
  db: SqliteDatabase,
  input: SqliteBulkRunPreviewInput
): Promise<SqliteBulkRunPreview> {
  validateBulkRunRequest(input);
  return (await computeBulkRunPreview(db, input)).preview;
}

export async function createSqliteBulkRunBatch(
  db: SqliteDatabase,
  input: SqliteBulkRunPreviewInput & {
    expectedSelectedRows: number;
    expectedSelectionDigest: string;
  }
) {
  validateBulkRunRequest(input);
  if (!Number.isInteger(input.expectedSelectedRows)) {
    throw new SqliteEnrichmentValidationError(
      'The confirmed bulk-run row count is invalid.'
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedSelectionDigest)) {
    throw new SqliteEnrichmentValidationError(
      'The confirmed bulk-run selection is invalid.'
    );
  }

  return withSqliteWriteTransaction(db, async (tx) => {
    const { preview, selectedRows } = await computeBulkRunPreview(tx, input);
    if (
      preview.selectedRows !== input.expectedSelectedRows ||
      preview.selectionDigest !== input.expectedSelectionDigest
    ) {
      throw new SqliteBulkRunConflictError(
        'The eligible row selection changed. Preview the bulk run again.'
      );
    }
    if (preview.selectedRows === 0) {
      throw new SqliteEnrichmentValidationError(
        'No rows are currently eligible for this bulk run.'
      );
    }
    if (preview.limitViolations.length > 0) {
      throw new SqliteEnrichmentValidationError(preview.limitViolations[0]!);
    }

    const [batch] = await tx
      .insert(bulkRunBatches)
      .values({
        columnId: input.columnId,
        createdByUserId: input.userId,
        estimatedMaxOutputTokens: preview.estimatedMaxOutputTokens,
        estimatedProviderRequests: preview.estimatedProviderRequests,
        mode: input.mode,
        selectedRowCount: preview.selectedRows,
        selectionDigest: preview.selectionDigest,
        selectionSnapshot: preview.selection,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!batch) throw new Error('The bulk run could not be created.');
    await tx.insert(bulkRunItems).values(
      selectedRows.map((row, sequence) => ({
        batchId: batch.id,
        rowId: row.id,
        sequence,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      }))
    );
    const durableInput = bulkRunInputSchema.parse({
      batchId: batch.id,
      workspaceId: input.workspaceId,
    });
    await tx.insert(outboxEvents).values({
      aggregateId: batch.id,
      aggregateType: 'bulk_run',
      eventType: 'column.bulk_run_requested',
      payload: durableInput,
      workspaceId: input.workspaceId,
    });
    return toSqliteBatchSummary(batch);
  });
}

export async function getSqliteBulkRunBatch(
  db: SqliteDatabase,
  input: {
    batchId: string;
    tableId: string;
    userId: string;
    workspaceId: string;
  }
) {
  const [record] = await db
    .select({ batch: bulkRunBatches })
    .from(bulkRunBatches)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, bulkRunBatches.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(bulkRunBatches.id, input.batchId),
        eq(bulkRunBatches.tableId, input.tableId),
        eq(bulkRunBatches.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!record) {
    throw new SqliteEnrichmentAccessError('The bulk run is not accessible.');
  }
  const items = await db
    .select({
      estimatedCostMicros: usageLedger.estimatedCostMicros,
      itemStatus: bulkRunItems.status,
      providerUnits: usageLedger.providerUnits,
      runStatus: cellRuns.status,
    })
    .from(bulkRunItems)
    .leftJoin(
      cellRuns,
      and(
        eq(cellRuns.id, bulkRunItems.runId),
        eq(cellRuns.workspaceId, bulkRunItems.workspaceId)
      )
    )
    .leftJoin(
      usageLedger,
      and(
        eq(usageLedger.runId, bulkRunItems.runId),
        eq(usageLedger.workspaceId, bulkRunItems.workspaceId)
      )
    )
    .where(
      and(
        eq(bulkRunItems.batchId, input.batchId),
        eq(bulkRunItems.workspaceId, input.workspaceId)
      )
    );
  const itemCounts = { pending: 0, queued: 0, skipped: 0 };
  const runCounts = {
    cancelled: 0,
    failed: 0,
    queued: 0,
    running: 0,
    succeeded: 0,
  };
  const usage = {
    estimatedCostMicros: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  for (const item of items) {
    itemCounts[item.itemStatus] += 1;
    if (item.runStatus) runCounts[item.runStatus] += 1;
    usage.estimatedCostMicros += item.estimatedCostMicros ?? 0;
    const tokenUnits = parseTokenUnits(item.providerUnits);
    if (tokenUnits) {
      usage.inputTokens += tokenUnits.inputTokens;
      usage.outputTokens += tokenUnits.outputTokens;
      usage.totalTokens += tokenUnits.totalTokens;
    }
  }
  return {
    ...toSqliteBatchSummary(record.batch),
    items: itemCounts,
    runs: runCounts,
    usage,
  };
}

export async function cancelSqliteBulkRunBatch(
  db: SqliteDatabase,
  input: {
    batchId: string;
    tableId: string;
    userId: string;
    workspaceId: string;
  }
) {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [batch] = await tx
      .select()
      .from(bulkRunBatches)
      .where(
        and(
          eq(bulkRunBatches.id, input.batchId),
          eq(bulkRunBatches.tableId, input.tableId),
          eq(bulkRunBatches.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!batch) {
      throw new SqliteEnrichmentAccessError('The bulk run is not accessible.');
    }
    const [membership] = await tx
      .select({ role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.workspaceId, input.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .limit(1);
    if (
      !membership ||
      !canCancelBulkRun({
        actorRole: membership.role,
        actorUserId: input.userId,
        createdByUserId: batch.createdByUserId,
      })
    ) {
      throw new SqliteEnrichmentAccessError('The bulk run is not accessible.');
    }
    if (batch.status === 'cancelled') return toSqliteBatchSummary(batch);
    if (batch.status === 'completed' || batch.status === 'failed') {
      throw new SqliteBulkRunConflictError(
        `A ${batch.status} bulk run cannot be cancelled.`
      );
    }

    const now = new Date();
    const skippedItems = await tx
      .update(bulkRunItems)
      .set({
        errorMessage: 'The batch was cancelled before this row was expanded.',
        status: 'skipped',
        updatedAt: now,
      })
      .where(
        and(
          eq(bulkRunItems.batchId, batch.id),
          eq(bulkRunItems.workspaceId, input.workspaceId),
          eq(bulkRunItems.status, 'pending')
        )
      )
      .returning({ rowId: bulkRunItems.rowId });
    const batchRunIds = await tx
      .select({ runId: bulkRunItems.runId })
      .from(bulkRunItems)
      .where(
        and(
          eq(bulkRunItems.batchId, batch.id),
          eq(bulkRunItems.workspaceId, input.workspaceId)
        )
      );
    const runIds = batchRunIds.flatMap(({ runId }) =>
      runId === null ? [] : [runId]
    );
    const cancelledRuns =
      runIds.length === 0
        ? []
        : await tx
            .update(cellRuns)
            .set({
              errorCode: 'cancelled_by_user',
              errorMessage: 'Cancelled with the parent bulk run.',
              finishedAt: now,
              status: 'cancelled',
              updatedAt: now,
            })
            .where(
              and(
                eq(cellRuns.workspaceId, input.workspaceId),
                inArray(cellRuns.id, runIds),
                inArray(cellRuns.status, ['queued', 'running'])
              )
            )
            .returning({ cellId: cellRuns.cellId });
    if (cancelledRuns.length > 0) {
      await tx
        .update(cells)
        .set({ status: 'cancelled', updatedAt: now })
        .where(
          and(
            eq(cells.workspaceId, input.workspaceId),
            inArray(
              cells.id,
              cancelledRuns.map(({ cellId }) => cellId)
            ),
            inArray(cells.status, ['queued', 'running'])
          )
        );
    }
    const [cancelled] = await tx
      .update(bulkRunBatches)
      .set({
        cancelledAt: now,
        cancelledByUserId: input.userId,
        errorMessage:
          'Cancelled by a workspace member. Provider requests already in flight may still complete.',
        finishedAt: now,
        skippedRowCount: sql`${bulkRunBatches.skippedRowCount} + ${skippedItems.length}`,
        status: 'cancelled',
        updatedAt: now,
      })
      .where(eq(bulkRunBatches.id, batch.id))
      .returning();
    if (!cancelled) throw new Error('The bulk run could not be cancelled.');
    return toSqliteBatchSummary(cancelled);
  });
}

export async function expandSqliteBulkRunBatchChunk(
  db: SqliteDatabase,
  rawInput: BulkRunInput,
  chunkSize = 50
): Promise<{ processed: number; status: string }> {
  const input = bulkRunInputSchema.parse(rawInput);
  const safeChunkSize = Math.max(1, Math.min(Math.trunc(chunkSize), 100));
  return withSqliteWriteTransaction(db, async (tx) => {
    const [batch] = await tx
      .select()
      .from(bulkRunBatches)
      .where(
        and(
          eq(bulkRunBatches.id, input.batchId),
          eq(bulkRunBatches.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!batch) throw new Error('The bulk run does not exist.');
    if (['completed', 'failed', 'cancelled'].includes(batch.status)) {
      return { processed: 0, status: batch.status };
    }
    if (!batch.createdByUserId) {
      await tx
        .update(bulkRunBatches)
        .set({
          errorMessage: 'The requesting user no longer exists.',
          finishedAt: new Date(),
          status: 'failed',
          updatedAt: new Date(),
        })
        .where(eq(bulkRunBatches.id, batch.id));
      return { processed: 0, status: 'failed' };
    }
    if (batch.status === 'queued') {
      await tx
        .update(bulkRunBatches)
        .set({
          startedAt: new Date(),
          status: 'running',
          updatedAt: new Date(),
        })
        .where(eq(bulkRunBatches.id, batch.id));
    }
    const items = await tx
      .select()
      .from(bulkRunItems)
      .where(
        and(
          eq(bulkRunItems.batchId, batch.id),
          eq(bulkRunItems.workspaceId, input.workspaceId),
          eq(bulkRunItems.status, 'pending')
        )
      )
      .orderBy(asc(bulkRunItems.sequence))
      .limit(safeChunkSize);
    let queued = 0;
    let skipped = 0;
    for (const item of items) {
      const [targetCell] = await tx
        .select({ status: cells.status })
        .from(cells)
        .where(
          and(
            eq(cells.rowId, item.rowId),
            eq(cells.columnId, batch.columnId),
            eq(cells.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!shouldSelectCellForBulkRun(targetCell?.status ?? null, batch.mode)) {
        await markSqliteBulkItemSkipped(
          tx,
          batch.id,
          item.rowId,
          'The cell no longer matches the selected run mode.'
        );
        skipped += 1;
        continue;
      }
      try {
        const run = await queueSqliteEnrichmentCellRunInTransaction(tx, {
          columnId: batch.columnId,
          mode: batch.mode,
          rowId: item.rowId,
          tableId: batch.tableId,
          userId: batch.createdByUserId,
          workspaceId: input.workspaceId,
        });
        await tx
          .update(bulkRunItems)
          .set({ runId: run.runId, status: 'queued', updatedAt: new Date() })
          .where(
            and(
              eq(bulkRunItems.batchId, batch.id),
              eq(bulkRunItems.rowId, item.rowId),
              eq(bulkRunItems.status, 'pending')
            )
          );
        queued += 1;
      } catch (error) {
        if (
          !(error instanceof SqliteEnrichmentAccessError) &&
          !(error instanceof SqliteEnrichmentValidationError)
        ) {
          throw error;
        }
        await markSqliteBulkItemSkipped(
          tx,
          batch.id,
          item.rowId,
          error.message.slice(0, 240)
        );
        skipped += 1;
      }
    }
    const processed = queued + skipped;
    const processedTotal =
      batch.queuedRowCount + batch.skippedRowCount + processed;
    const completed = processedTotal === batch.selectedRowCount;
    const missingItems = items.length === 0 && !completed;
    await tx
      .update(bulkRunBatches)
      .set({
        errorMessage: missingItems
          ? 'One or more selected rows no longer exists.'
          : null,
        finishedAt: completed || missingItems ? new Date() : null,
        queuedRowCount: sql`${bulkRunBatches.queuedRowCount} + ${queued}`,
        skippedRowCount: sql`${bulkRunBatches.skippedRowCount} + ${skipped}`,
        status: missingItems ? 'failed' : completed ? 'completed' : 'running',
        updatedAt: new Date(),
      })
      .where(eq(bulkRunBatches.id, batch.id));
    return {
      processed,
      status: missingItems ? 'failed' : completed ? 'completed' : 'running',
    };
  });
}

type SqliteBulkExecutor = Pick<SqliteDatabase, 'select'> | SqliteTransaction;

async function computeBulkRunPreview(
  db: SqliteBulkExecutor,
  input: SqliteBulkRunPreviewInput
): Promise<{
  preview: SqliteBulkRunPreview;
  selectedRows: Array<{ id: string }>;
}> {
  const plan = await requireColumnPlan(db, input);
  const selection = await resolveBulkRunSelection(db, input);
  const tableScope = and(
    eq(rows.workspaceId, input.workspaceId),
    eq(rows.tableId, input.tableId),
    isNull(rows.archivedAt)
  );
  const baseScope = and(
    tableScope,
    buildSqliteGridViewFilterTreePredicate(selection.filterTree),
    buildSqliteGridSearchPredicate(selection.snapshot.searchQuery)
  );
  const inputReady = inputReadyPredicate(db, input, plan.sourceColumnIds);
  const selectable = and(
    inputReady,
    targetModePredicate(db, input, input.mode)
  );
  const [[total], [scoped], [ready], [selected], selectedRows] =
    await Promise.all([
      db.select({ value: count() }).from(rows).where(tableScope),
      db.select({ value: count() }).from(rows).where(baseScope),
      db
        .select({ value: count() })
        .from(rows)
        .where(and(baseScope, inputReady)),
      db
        .select({ value: count() })
        .from(rows)
        .where(and(baseScope, selectable)),
      selectCandidateRows(db, input, plan, selection),
    ]);
  const totalRows = total?.value ?? 0;
  const scopedRows = scoped?.value ?? 0;
  const inputReadyRows = ready?.value ?? 0;
  const selectableRows = selected?.value ?? 0;
  const selectedRowCount = selectedRows.length;
  const estimatedProviderRequests =
    selectedRowCount * plan.providerRequestsPerRow * MAXIMUM_CELL_RUN_ATTEMPTS;
  const estimatedMaxOutputTokens =
    plan.maxOutputTokensPerRow === null
      ? null
      : selectedRowCount *
        plan.maxOutputTokensPerRow *
        MAXIMUM_CELL_RUN_ATTEMPTS;
  const limitViolations: string[] = [];
  if (selectedRowCount > input.limits.maxRows) {
    limitViolations.push(
      `This run selects ${selectedRowCount} rows; the deployment limit is ${input.limits.maxRows}.`
    );
  }
  if (estimatedProviderRequests > input.limits.maxProviderRequests) {
    limitViolations.push(
      `This run can make ${estimatedProviderRequests} provider requests; the deployment limit is ${input.limits.maxProviderRequests}.`
    );
  }
  if (
    estimatedMaxOutputTokens !== null &&
    estimatedMaxOutputTokens > input.limits.maxOutputTokens
  ) {
    limitViolations.push(
      `This run allows up to ${estimatedMaxOutputTokens} output tokens; the deployment limit is ${input.limits.maxOutputTokens}.`
    );
  }
  return {
    preview: {
      column: { id: plan.columnId, name: plan.columnName },
      estimatedMaxOutputTokens,
      estimatedProviderRequests,
      excludedByModeRows: inputReadyRows - selectableRows,
      inputReadyRows,
      limitViolations,
      limits: input.limits,
      mode: input.mode,
      requestedRowLimit: input.rowLimit,
      scopedRows,
      selectedRows: selectedRowCount,
      selection: selection.snapshot,
      selectionDigest: digestBulkRunSelection(
        selection.snapshot,
        selectedRows.map(({ id }) => id)
      ),
      totalRows,
    },
    selectedRows,
  };
}

interface ResolvedBulkRunSelection {
  filterTree: GridViewFilterGroup;
  snapshot: BulkRunSelectionSnapshot;
  sort: GridViewSort | null;
  sortValueType: SqliteGridSortableValueType | null;
}

async function resolveBulkRunSelection(
  db: SqliteBulkExecutor,
  input: SqliteBulkRunPreviewInput
): Promise<ResolvedBulkRunSelection> {
  const searchQuery = parseBulkRunSearchQuery(input.searchQuery);
  if (!input.viewId) {
    return {
      filterTree: { children: [], combinator: 'and' },
      snapshot: { kind: 'all_rows', searchQuery },
      sort: null,
      sortValueType: null,
    };
  }
  const view = await getSqliteSavedGridView(db as SqliteDatabase, {
    tableId: input.tableId,
    userId: input.userId,
    viewId: input.viewId,
    workspaceId: input.workspaceId,
  });
  let sortValueType: SqliteGridSortableValueType | null = null;
  if (view.sort) {
    const [sortColumn] = await db
      .select({ valueType: columns.valueType })
      .from(columns)
      .where(
        and(
          eq(columns.id, view.sort.columnId),
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt)
        )
      )
      .limit(1);
    if (
      !sortColumn ||
      sortColumn.valueType === 'empty' ||
      sortColumn.valueType === 'json'
    ) {
      throw new SqliteEnrichmentValidationError(
        'The saved-view sort column is invalid.'
      );
    }
    sortValueType = sortColumn.valueType;
  }
  return {
    filterTree: view.filterTree,
    snapshot: bulkRunSelectionSnapshotSchema.parse({
      filterTree: view.filterTree,
      kind: 'saved_view',
      name: view.name,
      searchQuery,
      sort: view.sort,
      updatedAt: view.updatedAt.toISOString(),
      viewId: view.id,
    }),
    sort: view.sort,
    sortValueType,
  };
}

async function selectCandidateRows(
  db: SqliteBulkExecutor,
  input: SqliteBulkRunPreviewInput,
  plan: Awaited<ReturnType<typeof requireColumnPlan>>,
  selection: ResolvedBulkRunSelection
) {
  const predicates = [
    eq(rows.workspaceId, input.workspaceId),
    eq(rows.tableId, input.tableId),
    isNull(rows.archivedAt),
    buildSqliteGridViewFilterTreePredicate(selection.filterTree),
    buildSqliteGridSearchPredicate(selection.snapshot.searchQuery),
    inputReadyPredicate(db, input, plan.sourceColumnIds),
    targetModePredicate(db, input, input.mode),
  ];
  if (!selection.sort || !selection.sortValueType) {
    return db
      .select({ id: rows.id })
      .from(rows)
      .where(and(...predicates))
      .orderBy(asc(rows.position), asc(rows.id))
      .limit(input.rowLimit);
  }
  const sortCells = alias(cells, 'sqlite_bulk_run_view_sort_cell');
  const { sortEmpty, sortValue } = sqliteGridViewSortExpressions(
    sortCells,
    selection.sortValueType
  );
  return db
    .select({ id: rows.id })
    .from(rows)
    .leftJoin(
      sortCells,
      and(
        eq(sortCells.workspaceId, rows.workspaceId),
        eq(sortCells.tableId, rows.tableId),
        eq(sortCells.rowId, rows.id),
        eq(sortCells.columnId, selection.sort.columnId)
      )
    )
    .where(and(...predicates))
    .orderBy(
      asc(sortEmpty),
      selection.sort.direction === 'asc' ? asc(sortValue) : desc(sortValue),
      selection.sort.direction === 'asc' ? asc(rows.id) : desc(rows.id)
    )
    .limit(input.rowLimit);
}

async function requireColumnPlan(
  db: SqliteBulkExecutor,
  input: SqliteBulkRunScope
) {
  const [target] = await db
    .select({
      configuration: columns.configuration,
      id: columns.id,
      name: columns.name,
    })
    .from(columns)
    .innerJoin(
      dataTables,
      and(
        eq(dataTables.id, columns.tableId),
        eq(dataTables.workspaceId, columns.workspaceId)
      )
    )
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, columns.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(columns.id, input.columnId),
        eq(columns.kind, 'connector'),
        eq(columns.tableId, input.tableId),
        eq(columns.workspaceId, input.workspaceId),
        isNull(columns.archivedAt),
        isNull(dataTables.archivedAt)
      )
    )
    .limit(1);
  if (!target) {
    throw new SqliteEnrichmentAccessError(
      'The enrichment column is not accessible.'
    );
  }
  const connector = connectorActionColumnConfigurationSchema.safeParse(
    target.configuration
  );
  if (!connector.success) {
    throw new SqliteEnrichmentValidationError(
      'The connector column configuration is invalid.'
    );
  }
  const sourceColumnIds = [
    ...new Set(
      Object.values(connector.data.inputBindings).flatMap((binding) =>
        binding.kind === 'column' ? [binding.columnId] : []
      )
    ),
  ];
  const tokenBinding = connector.data.inputBindings.max_output_tokens;
  return {
    columnId: target.id,
    columnName: target.name,
    maxOutputTokensPerRow:
      connector.data.connectorId === 'openai' &&
      tokenBinding?.kind === 'literal' &&
      typeof tokenBinding.value === 'number'
        ? tokenBinding.value
        : null,
    providerRequestsPerRow: 1,
    sourceColumnIds,
  };
}

function inputReadyPredicate(
  db: SqliteBulkExecutor,
  input: Pick<SqliteBulkRunScope, 'tableId' | 'workspaceId'>,
  sourceColumnIds: string[]
) {
  return and(
    ...sourceColumnIds.map((columnId) =>
      exists(
        db
          .select({ value: sql`1` })
          .from(cells)
          .where(
            and(
              eq(cells.rowId, rows.id),
              eq(cells.columnId, columnId),
              eq(cells.tableId, input.tableId),
              eq(cells.workspaceId, input.workspaceId),
              ne(cells.valueType, 'empty')
            )
          )
      )
    )
  );
}

function targetModePredicate(
  db: SqliteBulkExecutor,
  input: Pick<SqliteBulkRunScope, 'columnId' | 'tableId' | 'workspaceId'>,
  mode: BulkRunMode
) {
  return notExists(
    db
      .select({ value: sql`1` })
      .from(cells)
      .where(
        and(
          eq(cells.rowId, rows.id),
          eq(cells.columnId, input.columnId),
          eq(cells.tableId, input.tableId),
          eq(cells.workspaceId, input.workspaceId),
          inArray(cells.status, excludedBulkRunStatuses(mode))
        )
      )
  );
}

async function markSqliteBulkItemSkipped(
  tx: SqliteTransaction,
  batchId: string,
  rowId: string,
  errorMessage: string
) {
  await tx
    .update(bulkRunItems)
    .set({ errorMessage, status: 'skipped', updatedAt: new Date() })
    .where(
      and(
        eq(bulkRunItems.batchId, batchId),
        eq(bulkRunItems.rowId, rowId),
        eq(bulkRunItems.status, 'pending')
      )
    );
}

function validateBulkRunRequest(input: SqliteBulkRunPreviewInput): void {
  parseBulkRunSearchQuery(input.searchQuery);
  bulkRunModeSchema.parse(input.mode);
  if (
    input.viewId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.viewId
    )
  ) {
    throw new SqliteEnrichmentValidationError('The saved view is invalid.');
  }
  if (!Number.isInteger(input.rowLimit) || input.rowLimit < 1) {
    throw new SqliteEnrichmentValidationError(
      'A bulk run must request at least one row.'
    );
  }
  for (const [name, value] of Object.entries(input.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new SqliteEnrichmentValidationError(
        `The ${name} limit is invalid.`
      );
    }
  }
}

function parseBulkRunSearchQuery(
  value: string | null | undefined
): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = gridSearchQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new SqliteEnrichmentValidationError(
      'Search must contain 3 to 120 normalized characters.'
    );
  }
  return parsed.data;
}

function digestBulkRunSelection(
  selection: BulkRunSelectionSnapshot,
  rowIds: string[]
): string {
  const hash = createHash('sha256')
    .update('byok-grid:bulk-run-selection:v1\0')
    .update(JSON.stringify(selection));
  for (const rowId of rowIds) hash.update('\0').update(rowId);
  return hash.digest('hex');
}

function toSqliteBatchSummary(batch: typeof bulkRunBatches.$inferSelect) {
  return {
    cancelledAt: batch.cancelledAt?.toISOString() ?? null,
    cancelledByUserId: batch.cancelledByUserId,
    columnId: batch.columnId,
    errorMessage: batch.errorMessage,
    estimatedMaxOutputTokens: batch.estimatedMaxOutputTokens,
    estimatedProviderRequests: batch.estimatedProviderRequests,
    finishedAt: batch.finishedAt?.toISOString() ?? null,
    id: batch.id,
    mode: batch.mode,
    queuedRowCount: batch.queuedRowCount,
    selectedRowCount: batch.selectedRowCount,
    selection: bulkRunSelectionSnapshotSchema.parse(batch.selectionSnapshot),
    selectionDigest: batch.selectionDigest,
    skippedRowCount: batch.skippedRowCount,
    startedAt: batch.startedAt?.toISOString() ?? null,
    status: batch.status,
  };
}

function parseTokenUnits(value: string | null): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return typeof parsed.inputTokens === 'number' &&
      typeof parsed.outputTokens === 'number' &&
      typeof parsed.totalTokens === 'number'
      ? {
          inputTokens: parsed.inputTokens,
          outputTokens: parsed.outputTokens,
          totalTokens: parsed.totalTokens,
        }
      : null;
  } catch {
    return null;
  }
}
