import {
  gridViewFilterTreeSchema,
  MAXIMUM_WORKFLOW_ROW_BATCH_SIZE,
  workflowRowBatchSchema,
  type GridViewFilterGroup,
  type WorkflowRowBatch,
  type WorkflowRowReference,
} from '@byok-grid/domain';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import {
  deserializeSqliteCellValue,
  serializeSqliteCellValue,
} from './cell-values';
import { getSqliteGridSnapshot } from './grid';
import { recomputeDependentSqliteFormulasForRow } from './formulas';
import { recordSqliteRowMutationAndMaybeQueueSettlement } from './row-mutations';
import { SqliteWorkflowRunValidationError } from './workflow-runs';
import { buildSqliteGridViewFilterTreePredicate } from './grid-view-query';
import { cells, columns, dataTables, rows } from './schema';

const MAXIMUM_WORKFLOW_WRITE_CELLS = 5_000;

export async function selectSqliteWorkflowRowBatch(
  db: SqliteDatabase,
  input: {
    searchQuery: string | null;
    tableId: string;
    userId: string;
    viewId: string | null;
    workspaceId: string;
  }
): Promise<WorkflowRowBatch> {
  const selected: WorkflowRowReference[] = [];
  let cursor: string | null = null;
  do {
    const snapshot = await getSqliteGridSnapshot(
      db,
      {
        tableId: input.tableId,
        userId: input.userId,
        workspaceId: input.workspaceId,
      },
      {
        cursor,
        limit: Math.min(
          200,
          MAXIMUM_WORKFLOW_ROW_BATCH_SIZE + 1 - selected.length
        ),
        searchQuery: input.searchQuery,
        viewId: input.viewId,
      }
    );
    selected.push(
      ...snapshot.rows.map((row) => ({ rowId: row.id, tableId: input.tableId }))
    );
    if (selected.length > MAXIMUM_WORKFLOW_ROW_BATCH_SIZE) {
      throw new SqliteWorkflowRunValidationError(
        `A workflow row batch cannot exceed ${MAXIMUM_WORKFLOW_ROW_BATCH_SIZE} rows.`
      );
    }
    cursor = snapshot.pageInfo.nextCursor;
  } while (cursor);

  return workflowRowBatchSchema.parse({ rows: selected, schemaVersion: 1 });
}

export async function partitionSqliteWorkflowRowBatch(
  db: SqliteDatabase,
  input: {
    batch: WorkflowRowBatch;
    filterTree: GridViewFilterGroup;
    workspaceId: string;
  }
): Promise<{ matched: WorkflowRowBatch; rejected: WorkflowRowBatch }> {
  const batch = workflowRowBatchSchema.parse(input.batch);
  const filterTree = gridViewFilterTreeSchema.parse(input.filterTree);
  const grouped = new Map<string, WorkflowRowReference[]>();
  for (const row of batch.rows) {
    grouped.set(row.tableId, [...(grouped.get(row.tableId) ?? []), row]);
  }
  const matchedIds = new Set<string>();

  for (const [tableId, references] of grouped) {
    const ids = references.map((reference) => reference.rowId);
    for (let offset = 0; offset < ids.length; offset += 200) {
      const chunk = ids.slice(offset, offset + 200);
      const existing = await db
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
            eq(rows.workspaceId, input.workspaceId),
            eq(rows.tableId, tableId),
            inArray(rows.id, chunk),
            isNull(rows.archivedAt),
            isNull(dataTables.archivedAt)
          )
        );
      if (existing.length !== chunk.length) {
        throw new SqliteWorkflowRunValidationError(
          'A workflow row batch references an unavailable row.'
        );
      }

      const matching = await db
        .select({ id: rows.id })
        .from(rows)
        .where(
          and(
            eq(rows.workspaceId, input.workspaceId),
            eq(rows.tableId, tableId),
            inArray(rows.id, chunk),
            isNull(rows.archivedAt),
            buildSqliteGridViewFilterTreePredicate(filterTree)
          )
        );
      for (const row of matching) matchedIds.add(row.id);
    }
  }

  return {
    matched: {
      rows: batch.rows.filter((row) => matchedIds.has(row.rowId)),
      schemaVersion: 1,
    },
    rejected: {
      rows: batch.rows.filter((row) => !matchedIds.has(row.rowId)),
      schemaVersion: 1,
    },
  };
}

export async function writeSqliteWorkflowRowBatch(
  db: SqliteDatabase,
  input: {
    batch: WorkflowRowBatch;
    columnMappings: ReadonlyArray<{
      sourceColumnId: string;
      targetColumnId: string;
    }>;
    runId: string;
    stepId: string;
    tableId: string;
    workspaceId: string;
  }
): Promise<WorkflowRowBatch> {
  const batch = workflowRowBatchSchema.parse(input.batch);
  if (input.columnMappings.length === 0) {
    throw new SqliteWorkflowRunValidationError(
      'A write-table step needs at least one column mapping.'
    );
  }
  if (
    new Set(input.columnMappings.map((mapping) => mapping.targetColumnId))
      .size !== input.columnMappings.length
  ) {
    throw new SqliteWorkflowRunValidationError(
      'A write-table step cannot map a target column more than once.'
    );
  }
  if (
    batch.rows.length * input.columnMappings.length >
    MAXIMUM_WORKFLOW_WRITE_CELLS
  ) {
    throw new SqliteWorkflowRunValidationError(
      `A write-table step cannot materialize more than ${MAXIMUM_WORKFLOW_WRITE_CELLS} cells at once.`
    );
  }

  return withSqliteWriteTransaction(db, async (tx) => {
    const [targetTable] = await tx
      .select({ id: dataTables.id })
      .from(dataTables)
      .where(
        and(
          eq(dataTables.id, input.tableId),
          eq(dataTables.workspaceId, input.workspaceId),
          isNull(dataTables.archivedAt)
        )
      )
      .limit(1);
    if (!targetTable) {
      throw new SqliteWorkflowRunValidationError(
        'The write-table destination is unavailable.'
      );
    }

    const targetColumnIds = input.columnMappings.map(
      (mapping) => mapping.targetColumnId
    );
    const targetColumns = await tx
      .select({
        id: columns.id,
        kind: columns.kind,
        valueType: columns.valueType,
      })
      .from(columns)
      .where(
        and(
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId),
          inArray(columns.id, targetColumnIds),
          isNull(columns.archivedAt)
        )
      );
    if (
      targetColumns.length !== targetColumnIds.length ||
      targetColumns.some((column) => column.kind !== 'input')
    ) {
      throw new SqliteWorkflowRunValidationError(
        'Write-table targets must be active input columns.'
      );
    }
    const targetTypes = new Map(
      targetColumns.map((column) => [column.id, column.valueType])
    );

    const sourceByTable = new Map<string, WorkflowRowReference[]>();
    for (const reference of batch.rows) {
      sourceByTable.set(reference.tableId, [
        ...(sourceByTable.get(reference.tableId) ?? []),
        reference,
      ]);
    }
    const sourceColumnIds = [
      ...new Set(input.columnMappings.map((mapping) => mapping.sourceColumnId)),
    ];
    const sourceCells = new Map<
      string,
      ReturnType<typeof deserializeSqliteCellValue>
    >();

    for (const [tableId, references] of sourceByTable) {
      const sourceColumns = await tx
        .select({ id: columns.id, valueType: columns.valueType })
        .from(columns)
        .where(
          and(
            eq(columns.workspaceId, input.workspaceId),
            eq(columns.tableId, tableId),
            inArray(columns.id, sourceColumnIds),
            isNull(columns.archivedAt)
          )
        );
      if (sourceColumns.length !== sourceColumnIds.length) {
        throw new SqliteWorkflowRunValidationError(
          'A write-table source column is unavailable.'
        );
      }
      const sourceTypes = new Map(
        sourceColumns.map((column) => [column.id, column.valueType])
      );
      for (const mapping of input.columnMappings) {
        if (
          sourceTypes.get(mapping.sourceColumnId) !==
          targetTypes.get(mapping.targetColumnId)
        ) {
          throw new SqliteWorkflowRunValidationError(
            'A write-table mapping connects incompatible column types.'
          );
        }
      }

      const rowIds = references.map((reference) => reference.rowId);
      const existingRows = await tx
        .select({ id: rows.id })
        .from(rows)
        .where(
          and(
            eq(rows.workspaceId, input.workspaceId),
            eq(rows.tableId, tableId),
            inArray(rows.id, rowIds),
            isNull(rows.archivedAt)
          )
        );
      if (existingRows.length !== rowIds.length) {
        throw new SqliteWorkflowRunValidationError(
          'A write-table source row is unavailable.'
        );
      }
      const values = await tx
        .select({ cell: cells })
        .from(cells)
        .where(
          and(
            eq(cells.workspaceId, input.workspaceId),
            eq(cells.tableId, tableId),
            inArray(cells.rowId, rowIds),
            inArray(cells.columnId, sourceColumnIds)
          )
        );
      for (const { cell } of values) {
        sourceCells.set(
          `${tableId}:${cell.rowId}:${cell.columnId}`,
          deserializeSqliteCellValue(cell)
        );
      }
    }

    const targetRows = batch.rows.map((source, index) => ({
      id: deterministicWorkflowUuid(
        `${input.runId}:${input.stepId}:${source.tableId}:${source.rowId}`
      ),
      position: `workflow:${input.runId}:${input.stepId}:${String(index).padStart(6, '0')}`,
      source,
    }));
    const createdRows =
      targetRows.length > 0
        ? await tx
            .insert(rows)
            .values(
              targetRows.map((row) => ({
                id: row.id,
                position: row.position,
                tableId: input.tableId,
                workspaceId: input.workspaceId,
              }))
            )
            .onConflictDoNothing()
            .returning({ id: rows.id })
        : [];

    const targetCells = targetRows.flatMap((targetRow) =>
      input.columnMappings.flatMap((mapping) => {
        const value = sourceCells.get(
          `${targetRow.source.tableId}:${targetRow.source.rowId}:${mapping.sourceColumnId}`
        );
        if (!value) return [];
        return [
          {
            ...serializeSqliteCellValue(value),
            columnId: mapping.targetColumnId,
            id: deterministicWorkflowUuid(
              `${input.runId}:${input.stepId}:${targetRow.source.tableId}:${targetRow.source.rowId}:${mapping.targetColumnId}`
            ),
            rowId: targetRow.id,
            tableId: input.tableId,
            workspaceId: input.workspaceId,
          },
        ];
      })
    );
    for (let offset = 0; offset < targetCells.length; offset += 100) {
      await tx
        .insert(cells)
        .values(targetCells.slice(offset, offset + 100))
        .onConflictDoNothing();
    }
    const changedColumnIds = input.columnMappings.map(
      ({ targetColumnId }) => targetColumnId
    );
    for (const row of createdRows) {
      const changedFormulaIds = await recomputeDependentSqliteFormulasForRow(
        tx,
        {
          changedColumnIds,
          rowId: row.id,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        }
      );
      await recordSqliteRowMutationAndMaybeQueueSettlement(tx, {
        changedColumnIds: [...changedColumnIds, ...changedFormulaIds],
        rowId: row.id,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      });
    }

    return workflowRowBatchSchema.parse({
      rows: targetRows.map((row) => ({
        rowId: row.id,
        tableId: input.tableId,
      })),
      schemaVersion: 1,
    });
  });
}

function deterministicWorkflowUuid(value: string): string {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
