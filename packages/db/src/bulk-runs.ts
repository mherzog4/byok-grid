import {
  bulkRunInputSchema,
  bulkRunModeSchema,
  bulkRunSelectionSnapshotSchema,
  canCancelBulkRun,
  connectorActionColumnConfigurationSchema,
  excludedBulkRunStatuses,
  gridSearchQuerySchema,
  httpEnrichmentColumnConfigurationSchema,
  httpWaterfallColumnConfigurationSchema,
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
import type { Database } from './client';
import {
  EnrichmentAccessError,
  EnrichmentValidationError,
  queueEnrichmentCellRunInTransaction,
} from './enrichments';
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
import { createHash } from 'node:crypto';
import { alias } from 'drizzle-orm/pg-core';
import {
  buildGridSearchPredicate,
  buildGridViewFilterTreePredicate,
  gridViewSortExpressions,
  type GridSortableValueType,
} from './grid-view-query';
import { getSavedGridView } from './grid-views';

export class BulkRunConflictError extends Error {}

export interface BulkRunLimits {
  maxOutputTokens: number;
  maxProviderRequests: number;
  maxRows: number;
}

interface BulkRunScope {
  columnId: string;
  tableId: string;
  userId: string;
  workspaceId: string;
}

interface BulkRunPreviewInput extends BulkRunScope {
  limits: BulkRunLimits;
  mode: BulkRunMode;
  rowLimit: number;
  searchQuery?: string | null | undefined;
  viewId?: string | null | undefined;
}

export interface BulkRunPreview {
  column: { id: string; name: string };
  estimatedMaxOutputTokens: number | null;
  estimatedProviderRequests: number;
  excludedByModeRows: number;
  inputReadyRows: number;
  limitViolations: string[];
  limits: BulkRunLimits;
  mode: BulkRunMode;
  requestedRowLimit: number;
  scopedRows: number;
  selection: BulkRunSelectionSnapshot;
  selectionDigest: string;
  selectedRows: number;
  totalRows: number;
}

type BulkRunExecutor = Pick<Database, 'insert' | 'select' | 'update'>;

export async function previewBulkRun(
  db: Database,
  input: BulkRunPreviewInput
): Promise<BulkRunPreview> {
  validateBulkRunRequest(input);
  return (await computeBulkRunPreview(db, input)).preview;
}

export async function createBulkRunBatch(
  db: Database,
  input: BulkRunPreviewInput & {
    expectedSelectedRows: number;
    expectedSelectionDigest: string;
  }
) {
  validateBulkRunRequest(input);
  if (!Number.isInteger(input.expectedSelectedRows)) {
    throw new EnrichmentValidationError(
      'The confirmed bulk-run row count is invalid.'
    );
  }
  if (!/^[0-9a-f]{64}$/.test(input.expectedSelectionDigest)) {
    throw new EnrichmentValidationError(
      'The confirmed bulk-run selection is invalid.'
    );
  }

  return db.transaction(
    async (tx) => {
      const computed = await computeBulkRunPreview(tx, input);
      const { preview, selectedRows } = computed;
      if (
        preview.selectedRows !== input.expectedSelectedRows ||
        preview.selectionDigest !== input.expectedSelectionDigest
      ) {
        throw new BulkRunConflictError(
          'The eligible row selection changed. Preview the bulk run again.'
        );
      }
      if (preview.selectedRows === 0) {
        throw new EnrichmentValidationError(
          'No rows are currently eligible for this bulk run.'
        );
      }
      if (preview.limitViolations.length > 0) {
        throw new EnrichmentValidationError(preview.limitViolations[0]!);
      }

      const plan = await requireColumnPlan(tx, input);
      if (selectedRows.length !== preview.selectedRows) {
        throw new BulkRunConflictError(
          'The eligible rows changed. Preview the bulk run again.'
        );
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

      return toBatchSummary(batch);
    },
    { accessMode: 'read write', isolationLevel: 'repeatable read' }
  );
}

export async function getBulkRunBatch(
  db: Database,
  input: Pick<BulkRunScope, 'tableId' | 'userId' | 'workspaceId'> & {
    batchId: string;
  }
) {
  const [batch] = await db
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
  if (!batch)
    throw new EnrichmentAccessError('The bulk run is not accessible.');

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
    ...toBatchSummary(batch.batch),
    items: itemCounts,
    runs: runCounts,
    usage,
  };
}

export async function cancelBulkRunBatch(
  db: Database,
  input: Pick<BulkRunScope, 'tableId' | 'userId' | 'workspaceId'> & {
    batchId: string;
  }
) {
  return db.transaction(async (tx) => {
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
      .limit(1)
      .for('update');
    if (!batch) {
      throw new EnrichmentAccessError('The bulk run is not accessible.');
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
      throw new EnrichmentAccessError('The bulk run is not accessible.');
    }

    if (batch.status === 'cancelled') return toBatchSummary(batch);
    if (batch.status === 'completed' || batch.status === 'failed') {
      throw new BulkRunConflictError(
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

    const cancelledRuns = await tx
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
          inArray(cellRuns.status, ['queued', 'running']),
          exists(
            tx
              .select({ value: sql`1` })
              .from(bulkRunItems)
              .where(
                and(
                  eq(bulkRunItems.batchId, batch.id),
                  eq(bulkRunItems.workspaceId, input.workspaceId),
                  eq(bulkRunItems.runId, cellRuns.id)
                )
              )
          )
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
    return toBatchSummary(cancelled);
  });
}

export async function expandBulkRunBatchChunk(
  db: Database,
  rawInput: BulkRunInput,
  chunkSize = 50
): Promise<{ processed: number; status: string }> {
  const input = bulkRunInputSchema.parse(rawInput);
  const safeChunkSize = Math.max(1, Math.min(Math.trunc(chunkSize), 100));

  return db.transaction(async (tx) => {
    const [batch] = await tx
      .select()
      .from(bulkRunBatches)
      .where(
        and(
          eq(bulkRunBatches.id, input.batchId),
          eq(bulkRunBatches.workspaceId, input.workspaceId)
        )
      )
      .limit(1)
      .for('update');
    if (!batch) throw new Error('The bulk run does not exist.');
    if (
      batch.status === 'completed' ||
      batch.status === 'failed' ||
      batch.status === 'cancelled'
    ) {
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
      .limit(safeChunkSize)
      .for('update', { skipLocked: true });

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
        await markBulkItemSkipped(
          tx,
          batch.id,
          item.rowId,
          'The cell no longer matches the selected run mode.'
        );
        skipped += 1;
        continue;
      }

      try {
        const run = await queueEnrichmentCellRunInTransaction(tx, {
          columnId: batch.columnId,
          rowId: item.rowId,
          tableId: batch.tableId,
          userId: batch.createdByUserId,
          workspaceId: input.workspaceId,
        });
        await tx
          .update(bulkRunItems)
          .set({
            runId: run.runId,
            status: 'queued',
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(bulkRunItems.batchId, batch.id),
              eq(bulkRunItems.rowId, item.rowId)
            )
          );
        queued += 1;
      } catch (error) {
        if (
          !(error instanceof EnrichmentAccessError) &&
          !(error instanceof EnrichmentValidationError)
        ) {
          throw error;
        }
        await markBulkItemSkipped(
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

async function computeBulkRunPreview(
  db: BulkRunExecutor,
  input: BulkRunPreviewInput
): Promise<{ preview: BulkRunPreview; selectedRows: Array<{ id: string }> }> {
  const plan = await requireColumnPlan(db, input);
  const selection = await resolveBulkRunSelection(db, input);
  const viewPredicate = buildGridViewFilterTreePredicate(selection.filterTree);
  const searchPredicate = buildGridSearchPredicate(
    selection.snapshot.searchQuery
  );
  const tableScope = and(
    eq(rows.workspaceId, input.workspaceId),
    eq(rows.tableId, input.tableId),
    isNull(rows.archivedAt)
  );
  const baseScope = and(tableScope, viewPredicate, searchPredicate);
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
      selection: selection.snapshot,
      selectionDigest: digestBulkRunSelection(
        selection.snapshot,
        selectedRows.map((row) => row.id)
      ),
      selectedRows: selectedRowCount,
      totalRows,
    },
    selectedRows,
  };
}

interface ResolvedBulkRunSelection {
  filterTree: GridViewFilterGroup;
  snapshot: BulkRunSelectionSnapshot;
  sort: GridViewSort | null;
  sortValueType: GridSortableValueType | null;
}

async function resolveBulkRunSelection(
  db: BulkRunExecutor,
  input: BulkRunPreviewInput
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
  const view = await getSavedGridView(db as Database, {
    tableId: input.tableId,
    userId: input.userId,
    viewId: input.viewId,
    workspaceId: input.workspaceId,
  });
  let sortValueType: GridSortableValueType | null = null;
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
      throw new EnrichmentValidationError(
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
  db: BulkRunExecutor,
  input: BulkRunPreviewInput,
  plan: Awaited<ReturnType<typeof requireColumnPlan>>,
  selection: ResolvedBulkRunSelection
) {
  const predicates = [
    eq(rows.workspaceId, input.workspaceId),
    eq(rows.tableId, input.tableId),
    isNull(rows.archivedAt),
    buildGridViewFilterTreePredicate(selection.filterTree),
    buildGridSearchPredicate(selection.snapshot.searchQuery),
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

  const sortCells = alias(cells, 'bulk_run_view_sort_cell');
  const { sortEmpty, sortValue } = gridViewSortExpressions(
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

async function requireColumnPlan(db: BulkRunExecutor, input: BulkRunScope) {
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
    throw new EnrichmentAccessError('The enrichment column is not accessible.');
  }

  const waterfall = httpWaterfallColumnConfigurationSchema.safeParse(
    target.configuration
  );
  if (waterfall.success) {
    return {
      columnId: target.id,
      columnName: target.name,
      maxOutputTokensPerRow: null,
      providerRequestsPerRow: waterfall.data.providers.length,
      sourceColumnIds: [waterfall.data.inputColumnId],
    };
  }
  const connector = connectorActionColumnConfigurationSchema.safeParse(
    target.configuration
  );
  if (connector.success) {
    const sourceColumnIds = [
      ...new Set(
        Object.values(connector.data.inputBindings).flatMap((binding) =>
          binding.kind === 'column' ? [binding.columnId] : []
        )
      ),
    ];
    const tokenBinding = connector.data.inputBindings.max_output_tokens;
    const maxOutputTokensPerRow =
      connector.data.connectorId === 'openai' &&
      tokenBinding?.kind === 'literal' &&
      typeof tokenBinding.value === 'number'
        ? tokenBinding.value
        : null;
    return {
      columnId: target.id,
      columnName: target.name,
      maxOutputTokensPerRow,
      providerRequestsPerRow: 1,
      sourceColumnIds,
    };
  }
  const http = httpEnrichmentColumnConfigurationSchema.safeParse(
    target.configuration
  );
  if (http.success) {
    return {
      columnId: target.id,
      columnName: target.name,
      maxOutputTokensPerRow: null,
      providerRequestsPerRow: 1,
      sourceColumnIds: [http.data.inputColumnId],
    };
  }
  throw new EnrichmentValidationError(
    'The enrichment column configuration is invalid.'
  );
}

function inputReadyPredicate(
  db: BulkRunExecutor,
  input: Pick<BulkRunScope, 'tableId' | 'workspaceId'>,
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
  db: BulkRunExecutor,
  input: Pick<BulkRunScope, 'columnId' | 'tableId' | 'workspaceId'>,
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

async function markBulkItemSkipped(
  tx: BulkRunExecutor,
  batchId: string,
  rowId: string,
  errorMessage: string
) {
  await tx
    .update(bulkRunItems)
    .set({ errorMessage, status: 'skipped', updatedAt: new Date() })
    .where(
      and(eq(bulkRunItems.batchId, batchId), eq(bulkRunItems.rowId, rowId))
    );
}

function validateBulkRunRequest(input: BulkRunPreviewInput): void {
  parseBulkRunSearchQuery(input.searchQuery);
  bulkRunModeSchema.parse(input.mode);
  if (
    input.viewId &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.viewId
    )
  ) {
    throw new EnrichmentValidationError('The saved view is invalid.');
  }
  if (!Number.isInteger(input.rowLimit) || input.rowLimit < 1) {
    throw new EnrichmentValidationError(
      'A bulk run must request at least one row.'
    );
  }
  for (const [name, value] of Object.entries(input.limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new EnrichmentValidationError(`The ${name} limit is invalid.`);
    }
  }
}

function parseBulkRunSearchQuery(
  value: string | null | undefined
): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = gridSearchQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new EnrichmentValidationError(
      'Search must contain 3 to 120 normalized characters.'
    );
  }
  return parsed.data;
}

function toBatchSummary(batch: typeof bulkRunBatches.$inferSelect) {
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
