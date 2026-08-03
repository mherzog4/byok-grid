import {
  ColumnCellConversionError,
  columnTypeConversionPreviewRequestSchema,
  columnTypeConversionRequestSchema,
  convertColumnCellValue,
  gridViewFilterLeaves,
  hasWorkspacePermission,
  normalizeGridViewFilterTree,
  schemaArchiveRequestSchema,
  type EditableInputValueType,
  type WorkspaceRole,
} from '@byok-grid/domain';
import { and, asc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { deserializeCellValue, serializeCellValue } from './cell-values';
import type { Database } from './client';
import {
  GridAccessError,
  GridConflictError,
  GridValidationError,
} from './grid';
import {
  bulkRunBatches,
  cells,
  columnDependencies,
  columns,
  dataTables,
  importJobs,
  ingestionBatches,
  ingestionEndpoints,
  rows,
  rowSettlements,
  savedGridViews,
  schemaLifecycleEvents,
  sourceDefinitions,
  sourceRuns,
  webhookDeliveries,
  webhookDestinations,
  workspaceMembers,
  writebackDeliveries,
  writebackDestinations,
} from './schema';
import { lockTableCellSchemaExclusive } from './schema-locks';

type LifecycleExecutor = Pick<
  Database,
  'execute' | 'insert' | 'select' | 'update'
>;

interface WorkspaceScope {
  userId: string;
  workspaceId: string;
}

interface TableScope extends WorkspaceScope {
  tableId: string;
}

interface ColumnScope extends TableScope {
  columnId: string;
}

export interface SchemaLifecycleBlocker {
  code:
    | 'active_sources'
    | 'active_ingestion'
    | 'active_webhooks'
    | 'active_work'
    | 'active_writebacks'
    | 'dependent_columns'
    | 'conversion_failures'
    | 'last_column'
    | 'last_table'
    | 'saved_views'
    | 'source_mappings'
    | 'writeback_mappings';
  count: number;
  message: string;
}

export interface TableArchivePreview {
  blockers: SchemaLifecycleBlocker[];
  canArchive: boolean;
  impact: {
    columns: number;
    rows: number;
    savedViews: number;
    retainedRuns: number;
  };
  table: { id: string; name: string };
}

export interface ColumnArchivePreview {
  blockers: SchemaLifecycleBlocker[];
  canArchive: boolean;
  column: { id: string; kind: string; name: string };
  impact: {
    cells: number;
    pausedSourceMappings: number;
    pausedWritebackMappings: number;
    savedViews: number;
  };
  table: { id: string; name: string };
}

export interface ColumnTypeConversionFailure {
  code: string;
  message: string;
  rowId: string;
  rowPosition: string;
}

export interface ColumnTypeConversionPreview {
  blockers: SchemaLifecycleBlocker[];
  canConvert: boolean;
  column: {
    id: string;
    kind: string;
    name: string;
    valueType: EditableInputValueType;
  };
  failures: ColumnTypeConversionFailure[];
  impact: {
    convertibleCells: number;
    emptyCells: number;
    failedCells: number;
    totalCells: number;
  };
  previewDigest: string;
  table: { id: string; name: string };
  targetType: EditableInputValueType;
}

export interface ArchivedTableSummary {
  archivedAt: Date;
  id: string;
  name: string;
}

export interface ArchivedColumnSummary extends ArchivedTableSummary {
  kind: string;
}

export async function listArchivedWorkspaceTables(
  db: Database,
  scope: WorkspaceScope
): Promise<ArchivedTableSummary[]> {
  await requireSchemaManager(db, scope);
  return db
    .select({
      archivedAt: dataTables.archivedAt,
      id: dataTables.id,
      name: dataTables.name,
    })
    .from(dataTables)
    .where(
      and(
        eq(dataTables.workspaceId, scope.workspaceId),
        isNotNull(dataTables.archivedAt)
      )
    )
    .orderBy(asc(dataTables.archivedAt))
    .then((items) =>
      items.map((item) => ({ ...item, archivedAt: item.archivedAt! }))
    );
}

export async function listArchivedTableColumns(
  db: Database,
  scope: TableScope
): Promise<ArchivedColumnSummary[]> {
  await requireActiveTable(db, scope);
  await requireSchemaManager(db, scope);
  return db
    .select({
      archivedAt: columns.archivedAt,
      id: columns.id,
      kind: columns.kind,
      name: columns.name,
    })
    .from(columns)
    .where(
      and(
        eq(columns.workspaceId, scope.workspaceId),
        eq(columns.tableId, scope.tableId),
        isNotNull(columns.archivedAt)
      )
    )
    .orderBy(asc(columns.archivedAt))
    .then((items) =>
      items.map((item) => ({ ...item, archivedAt: item.archivedAt! }))
    );
}

export async function previewTableArchive(
  db: Database,
  scope: TableScope
): Promise<TableArchivePreview> {
  await requireSchemaManager(db, scope);
  return buildTableArchivePreview(db, scope);
}

export async function archiveWorkspaceTable(
  db: Database,
  input: TableScope & { confirmationName: string },
  now = new Date()
): Promise<{ archivedAt: Date; id: string; name: string }> {
  const request = schemaArchiveRequestSchema.parse({
    confirmationName: input.confirmationName,
  });
  return db.transaction(async (tx) => {
    await lockLifecycle(tx, `workspace-tables:${input.workspaceId}`);
    await requireSchemaManager(tx, input);
    const preview = await buildTableArchivePreview(tx, input);
    requireConfirmation(request.confirmationName, preview.table.name);
    requireNoBlockers(preview.blockers);

    const [archived] = await tx
      .update(dataTables)
      .set({
        archivedAt: now,
        archivedByUserId: input.userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(dataTables.id, input.tableId),
          eq(dataTables.workspaceId, input.workspaceId),
          isNull(dataTables.archivedAt)
        )
      )
      .returning({ id: dataTables.id, name: dataTables.name });
    if (!archived) throw new GridAccessError('The table is not accessible.');

    await tx.insert(schemaLifecycleEvents).values({
      action: 'table_archived',
      actorUserId: input.userId,
      snapshot: { impact: preview.impact, name: archived.name },
      tableId: archived.id,
      workspaceId: input.workspaceId,
    });
    return { ...archived, archivedAt: now };
  });
}

export async function restoreWorkspaceTable(
  db: Database,
  input: TableScope,
  now = new Date()
): Promise<{ id: string; name: string }> {
  return db.transaction(async (tx) => {
    await lockLifecycle(tx, `workspace-tables:${input.workspaceId}`);
    await requireSchemaManager(tx, input);
    const [table] = await tx
      .select({
        archivedAt: dataTables.archivedAt,
        id: dataTables.id,
        name: dataTables.name,
      })
      .from(dataTables)
      .where(
        and(
          eq(dataTables.id, input.tableId),
          eq(dataTables.workspaceId, input.workspaceId),
          isNotNull(dataTables.archivedAt)
        )
      )
      .limit(1);
    if (!table?.archivedAt)
      throw new GridAccessError('The archived table is not accessible.');

    const [restored] = await tx
      .update(dataTables)
      .set({ archivedAt: null, archivedByUserId: null, updatedAt: now })
      .where(eq(dataTables.id, table.id))
      .returning({ id: dataTables.id, name: dataTables.name });
    if (!restored) throw new Error('The table could not be restored.');

    await tx.insert(schemaLifecycleEvents).values({
      action: 'table_restored',
      actorUserId: input.userId,
      snapshot: {
        archivedAt: table.archivedAt.toISOString(),
        name: table.name,
      },
      tableId: table.id,
      workspaceId: input.workspaceId,
    });
    return restored;
  });
}

export async function previewColumnArchive(
  db: Database,
  scope: ColumnScope
): Promise<ColumnArchivePreview> {
  await requireSchemaManager(db, scope);
  return buildColumnArchivePreview(db, scope);
}

export async function previewColumnTypeConversion(
  db: Database,
  input: ColumnScope & { targetType: EditableInputValueType }
): Promise<ColumnTypeConversionPreview> {
  const request = columnTypeConversionPreviewRequestSchema.parse({
    targetType: input.targetType,
  });
  await requireSchemaManager(db, input);
  return buildColumnTypeConversionPreview(db, {
    ...input,
    targetType: request.targetType,
  });
}

export async function convertWorkspaceColumnType(
  db: Database,
  input: ColumnScope & {
    confirmationName: string;
    previewDigest: string;
    targetType: EditableInputValueType;
  },
  now = new Date()
): Promise<{
  convertedCells: number;
  fromValueType: EditableInputValueType;
  id: string;
  name: string;
  toValueType: EditableInputValueType;
}> {
  const request = columnTypeConversionRequestSchema.parse({
    confirmationName: input.confirmationName,
    previewDigest: input.previewDigest,
    targetType: input.targetType,
  });
  return db.transaction(async (tx) => {
    await requireSchemaManager(tx, input);
    await lockTableCellSchemaExclusive(tx, input);
    await lockLifecycle(
      tx,
      `table-columns:${input.workspaceId}:${input.tableId}`
    );
    const preview = await buildColumnTypeConversionPreview(tx, {
      ...input,
      targetType: request.targetType,
    });
    requireConversionConfirmation(
      request.confirmationName,
      preview.column.name
    );
    if (preview.previewDigest !== request.previewDigest) {
      throw new GridConflictError(
        'The column changed after the preview. Review the conversion again.'
      );
    }
    requireNoBlockers(preview.blockers);

    const convertedCells = await applyColumnTypeConversion(
      tx,
      {
        ...input,
        targetType: request.targetType,
      },
      now
    );
    const [updated] = await tx
      .update(columns)
      .set({ valueType: request.targetType, updatedAt: now })
      .where(
        and(
          eq(columns.id, input.columnId),
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId),
          eq(columns.kind, 'input'),
          eq(columns.valueType, preview.column.valueType),
          isNull(columns.archivedAt)
        )
      )
      .returning({ id: columns.id, name: columns.name });
    if (!updated) {
      throw new GridConflictError(
        'The column changed while the conversion was being applied.'
      );
    }

    await tx.insert(schemaLifecycleEvents).values({
      action: 'column_type_converted',
      actorUserId: input.userId,
      columnId: updated.id,
      snapshot: {
        convertedCells,
        emptyCells: preview.impact.emptyCells,
        failurePolicy: 'atomic',
        fromValueType: preview.column.valueType,
        name: updated.name,
        previewDigest: preview.previewDigest,
        toValueType: request.targetType,
      },
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    });
    return {
      convertedCells,
      fromValueType: preview.column.valueType,
      id: updated.id,
      name: updated.name,
      toValueType: request.targetType,
    };
  });
}

export async function archiveWorkspaceColumn(
  db: Database,
  input: ColumnScope & { confirmationName: string },
  now = new Date()
): Promise<{ archivedAt: Date; id: string; name: string }> {
  const request = schemaArchiveRequestSchema.parse({
    confirmationName: input.confirmationName,
  });
  return db.transaction(async (tx) => {
    await lockLifecycle(
      tx,
      `table-columns:${input.workspaceId}:${input.tableId}`
    );
    await requireSchemaManager(tx, input);
    const preview = await buildColumnArchivePreview(tx, input);
    requireConfirmation(request.confirmationName, preview.column.name);
    requireNoBlockers(preview.blockers);

    const [archived] = await tx
      .update(columns)
      .set({
        archivedAt: now,
        archivedByUserId: input.userId,
        updatedAt: now,
      })
      .where(
        and(
          eq(columns.id, input.columnId),
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt)
        )
      )
      .returning({ id: columns.id, name: columns.name });
    if (!archived) throw new GridAccessError('The column is not accessible.');

    await tx.insert(schemaLifecycleEvents).values({
      action: 'column_archived',
      actorUserId: input.userId,
      columnId: archived.id,
      snapshot: {
        impact: preview.impact,
        kind: preview.column.kind,
        name: archived.name,
      },
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    });
    return { ...archived, archivedAt: now };
  });
}

export async function restoreWorkspaceColumn(
  db: Database,
  input: ColumnScope,
  now = new Date()
): Promise<{ id: string; name: string }> {
  return db.transaction(async (tx) => {
    await lockLifecycle(
      tx,
      `table-columns:${input.workspaceId}:${input.tableId}`
    );
    await requireSchemaManager(tx, input);
    const table = await requireActiveTable(tx, input);
    const [column] = await tx
      .select({
        archivedAt: columns.archivedAt,
        id: columns.id,
        name: columns.name,
      })
      .from(columns)
      .where(
        and(
          eq(columns.id, input.columnId),
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNotNull(columns.archivedAt)
        )
      )
      .limit(1);
    if (!column?.archivedAt)
      throw new GridAccessError('The archived column is not accessible.');

    const [missingDependency] = await tx
      .select({ id: columns.id, name: columns.name })
      .from(columnDependencies)
      .innerJoin(columns, eq(columns.id, columnDependencies.dependsOnColumnId))
      .where(
        and(
          eq(columnDependencies.workspaceId, input.workspaceId),
          eq(columnDependencies.tableId, input.tableId),
          eq(columnDependencies.columnId, input.columnId),
          isNotNull(columns.archivedAt)
        )
      )
      .limit(1);
    if (missingDependency) {
      throw new GridConflictError(
        `Restore the archived dependency “${missingDependency.name}” first.`
      );
    }

    const [restored] = await tx
      .update(columns)
      .set({ archivedAt: null, archivedByUserId: null, updatedAt: now })
      .where(eq(columns.id, column.id))
      .returning({ id: columns.id, name: columns.name });
    if (!restored) throw new Error('The column could not be restored.');

    await tx.insert(schemaLifecycleEvents).values({
      action: 'column_restored',
      actorUserId: input.userId,
      columnId: column.id,
      snapshot: {
        archivedAt: column.archivedAt.toISOString(),
        name: column.name,
        tableName: table.name,
      },
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    });
    return restored;
  });
}

const COLUMN_CONVERSION_SCAN_PAGE_SIZE = 1_000;
const COLUMN_CONVERSION_FAILURE_SAMPLE_SIZE = 10;

async function buildColumnTypeConversionPreview(
  db: LifecycleExecutor,
  scope: ColumnScope & { targetType: EditableInputValueType }
): Promise<ColumnTypeConversionPreview> {
  const table = await requireActiveTable(db, scope);
  const [storedColumn] = await db
    .select({
      id: columns.id,
      kind: columns.kind,
      name: columns.name,
      valueType: columns.valueType,
    })
    .from(columns)
    .where(
      and(
        eq(columns.id, scope.columnId),
        eq(columns.workspaceId, scope.workspaceId),
        eq(columns.tableId, scope.tableId),
        isNull(columns.archivedAt)
      )
    )
    .limit(1);
  if (!storedColumn) throw new GridAccessError('The column is not accessible.');
  if (storedColumn.kind !== 'input' || storedColumn.valueType === 'empty') {
    throw new GridValidationError('Only typed input columns can be converted.');
  }
  const column = {
    ...storedColumn,
    valueType: storedColumn.valueType as EditableInputValueType,
  };
  if (column.valueType === scope.targetType) {
    throw new GridValidationError(
      `The column already uses the ${scope.targetType} type.`
    );
  }

  const [counts, dependents, sources, ingestion, writebacks, views] =
    await Promise.all([
      db
        .select({
          activeWork: sql<number>`(
            (select count(*) from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.tableId} = ${scope.tableId} and ${cells.columnId} = ${scope.columnId} and ${cells.status} in ('queued', 'running')) +
            (select count(*) from ${importJobs} where ${importJobs.workspaceId} = ${scope.workspaceId} and ${importJobs.tableId} = ${scope.tableId} and ${importJobs.status} in ('staging', 'queued', 'running')) +
            (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId} and ${sourceRuns.tableId} = ${scope.tableId} and ${sourceRuns.status} in ('queued', 'running')) +
            (select count(*) from ${ingestionBatches} where ${ingestionBatches.workspaceId} = ${scope.workspaceId} and ${ingestionBatches.tableId} = ${scope.tableId} and ${ingestionBatches.status} in ('queued', 'running'))
          )::int`,
        })
        .from(columns)
        .where(eq(columns.id, scope.columnId))
        .limit(1)
        .then((items) => items[0]),
      db
        .select({ id: columns.id })
        .from(columnDependencies)
        .innerJoin(columns, eq(columns.id, columnDependencies.columnId))
        .where(
          and(
            eq(columnDependencies.workspaceId, scope.workspaceId),
            eq(columnDependencies.tableId, scope.tableId),
            eq(columnDependencies.dependsOnColumnId, scope.columnId),
            isNull(columns.archivedAt)
          )
        ),
      db
        .select({
          fieldMapping: sourceDefinitions.fieldMapping,
          id: sourceDefinitions.id,
          status: sourceDefinitions.status,
        })
        .from(sourceDefinitions)
        .where(
          and(
            eq(sourceDefinitions.workspaceId, scope.workspaceId),
            eq(sourceDefinitions.tableId, scope.tableId)
          )
        ),
      db
        .select({
          fieldMapping: ingestionEndpoints.fieldMapping,
          id: ingestionEndpoints.id,
          revokedAt: ingestionEndpoints.revokedAt,
        })
        .from(ingestionEndpoints)
        .where(
          and(
            eq(ingestionEndpoints.workspaceId, scope.workspaceId),
            eq(ingestionEndpoints.tableId, scope.tableId)
          )
        ),
      db
        .select({
          fieldMappings: writebackDestinations.fieldMappings,
          filterTree: writebackDestinations.filterTree,
          id: writebackDestinations.id,
          recordIdColumnId: writebackDestinations.recordIdColumnId,
        })
        .from(writebackDestinations)
        .where(
          and(
            eq(writebackDestinations.workspaceId, scope.workspaceId),
            eq(writebackDestinations.tableId, scope.tableId)
          )
        ),
      db
        .select({ filters: savedGridViews.filters, sort: savedGridViews.sort })
        .from(savedGridViews)
        .where(
          and(
            eq(savedGridViews.workspaceId, scope.workspaceId),
            eq(savedGridViews.tableId, scope.tableId)
          )
        ),
    ]);
  if (!counts) throw new GridAccessError('The column is not accessible.');

  const activeSourceMappings = sources.filter(
    (source) =>
      source.status === 'active' &&
      (source.fieldMapping ?? []).some(
        (mapping) => mapping.columnId === scope.columnId
      )
  );
  const activeIngestionMappings = ingestion.filter(
    (endpoint) =>
      !endpoint.revokedAt &&
      (endpoint.fieldMapping ?? []).some(
        (mapping) => mapping.columnId === scope.columnId
      )
  );
  const referencingWritebacks = writebacks.filter(
    (destination) =>
      destination.recordIdColumnId === scope.columnId ||
      destination.fieldMappings.some(
        (mapping) => mapping.columnId === scope.columnId
      ) ||
      gridViewFilterLeaves(
        normalizeGridViewFilterTree(destination.filterTree)
      ).some((filter) => filter.columnId === scope.columnId)
  );
  const referencingViews = views.filter(
    (view) =>
      view.sort?.columnId === scope.columnId ||
      gridViewFilterLeaves(normalizeGridViewFilterTree(view.filters)).some(
        (filter) => filter.columnId === scope.columnId
      )
  );
  const scan = await scanColumnTypeConversion(db, scope, column.valueType);
  const blockers: SchemaLifecycleBlocker[] = [];
  pushBlocker(
    blockers,
    'active_work',
    counts.activeWork,
    'Wait for active imports, source runs, ingestion batches, and cell work to finish.'
  );
  pushBlocker(
    blockers,
    'dependent_columns',
    dependents.length,
    'Archive dependent formula and connector columns before converting this column.'
  );
  pushBlocker(
    blockers,
    'source_mappings',
    activeSourceMappings.length,
    'Pause sources that map into this column before converting it.'
  );
  pushBlocker(
    blockers,
    'active_ingestion',
    activeIngestionMappings.length,
    'Revoke ingestion endpoints that map into this column before converting it.'
  );
  pushBlocker(
    blockers,
    'writeback_mappings',
    referencingWritebacks.length,
    'Remove writebacks that reference this column before converting it.'
  );
  pushBlocker(
    blockers,
    'saved_views',
    referencingViews.length,
    'Update or delete saved views that reference this column before converting it.'
  );
  pushBlocker(
    blockers,
    'conversion_failures',
    scan.impact.failedCells,
    'Fix or clear cells that cannot be converted safely.'
  );
  scan.digest.update(
    JSON.stringify(blockers.map(({ code, count }) => ({ code, count })))
  );

  return {
    blockers,
    canConvert: blockers.length === 0,
    column,
    failures: scan.failures,
    impact: scan.impact,
    previewDigest: scan.digest.digest('hex'),
    table,
    targetType: scope.targetType,
  };
}

async function scanColumnTypeConversion(
  db: LifecycleExecutor,
  scope: ColumnScope & { targetType: EditableInputValueType },
  currentType: EditableInputValueType
): Promise<{
  digest: ReturnType<typeof createHash>;
  failures: ColumnTypeConversionFailure[];
  impact: ColumnTypeConversionPreview['impact'];
}> {
  const digest = createHash('sha256');
  digest.update(
    `column-conversion-v1\0${scope.workspaceId}\0${scope.tableId}\0${scope.columnId}\0${currentType}\0${scope.targetType}\0`
  );
  const failures: ColumnTypeConversionFailure[] = [];
  const impact = {
    convertibleCells: 0,
    emptyCells: 0,
    failedCells: 0,
    totalCells: 0,
  };
  let lastCellId: string | undefined;
  while (true) {
    const page = await db
      .select({ cell: cells, rowPosition: rows.position })
      .from(cells)
      .innerJoin(
        rows,
        and(
          eq(rows.id, cells.rowId),
          eq(rows.tableId, cells.tableId),
          eq(rows.workspaceId, cells.workspaceId)
        )
      )
      .where(
        and(
          eq(cells.workspaceId, scope.workspaceId),
          eq(cells.tableId, scope.tableId),
          eq(cells.columnId, scope.columnId),
          ...(lastCellId ? [gt(cells.id, lastCellId)] : [])
        )
      )
      .orderBy(asc(cells.id))
      .limit(COLUMN_CONVERSION_SCAN_PAGE_SIZE);
    for (const { cell, rowPosition } of page) {
      impact.totalCells += 1;
      digest.update(`${cell.id}\0${cell.version}\0${cell.valueType}\0`);
      if (cell.valueType === 'empty') {
        impact.emptyCells += 1;
        continue;
      }
      let failure: Omit<
        ColumnTypeConversionFailure,
        'rowId' | 'rowPosition'
      > | null = null;
      if (cell.valueType !== currentType) {
        failure = {
          code: 'stored_type_mismatch',
          message: `The stored ${cell.valueType} value does not match the column's ${currentType} type.`,
        };
      } else {
        try {
          convertColumnCellValue(deserializeCellValue(cell), scope.targetType);
          impact.convertibleCells += 1;
        } catch (error) {
          failure = {
            code:
              error instanceof ColumnCellConversionError
                ? error.code
                : 'conversion_failed',
            message:
              error instanceof Error
                ? error.message
                : 'The cell cannot be converted safely.',
          };
        }
      }
      if (failure) {
        impact.failedCells += 1;
        if (failures.length < COLUMN_CONVERSION_FAILURE_SAMPLE_SIZE) {
          failures.push({
            ...failure,
            rowId: cell.rowId,
            rowPosition,
          });
        }
      }
    }
    if (page.length < COLUMN_CONVERSION_SCAN_PAGE_SIZE) break;
    lastCellId = page.at(-1)!.cell.id;
  }
  return { digest, failures, impact };
}

async function applyColumnTypeConversion(
  db: LifecycleExecutor,
  scope: ColumnScope & { targetType: EditableInputValueType },
  now: Date
): Promise<number> {
  let convertedCells = 0;
  let lastCellId: string | undefined;
  while (true) {
    const page = await db
      .select({ cell: cells })
      .from(cells)
      .where(
        and(
          eq(cells.workspaceId, scope.workspaceId),
          eq(cells.tableId, scope.tableId),
          eq(cells.columnId, scope.columnId),
          sql`${cells.valueType} <> 'empty'`,
          ...(lastCellId ? [gt(cells.id, lastCellId)] : [])
        )
      )
      .orderBy(asc(cells.id))
      .limit(COLUMN_CONVERSION_SCAN_PAGE_SIZE);
    if (page.length === 0) break;
    const values = page.map(({ cell }) => ({
      ...serializeCellValue(
        convertColumnCellValue(deserializeCellValue(cell), scope.targetType)
      ),
      columnId: cell.columnId,
      id: cell.id,
      rowId: cell.rowId,
      status: 'idle' as const,
      tableId: cell.tableId,
      updatedAt: now,
      workspaceId: cell.workspaceId,
    }));
    await db
      .insert(cells)
      .values(values)
      .onConflictDoUpdate({
        target: cells.id,
        set: {
          status: sql.raw('excluded.status'),
          updatedAt: sql.raw('excluded.updated_at'),
          valueBoolean: sql.raw('excluded.value_boolean'),
          valueJson: sql.raw('excluded.value_json'),
          valueNumber: sql.raw('excluded.value_number'),
          valueText: sql.raw('excluded.value_text'),
          valueTimestamp: sql.raw('excluded.value_timestamp'),
          valueType: sql.raw('excluded.value_type'),
          version: sql`${cells.version} + 1`,
        },
      });
    convertedCells += page.length;
    lastCellId = page.at(-1)!.cell.id;
    if (page.length < COLUMN_CONVERSION_SCAN_PAGE_SIZE) break;
  }
  return convertedCells;
}

async function buildTableArchivePreview(
  db: LifecycleExecutor,
  scope: TableScope
): Promise<TableArchivePreview> {
  const table = await requireActiveTable(db, scope);
  const [counts] = await db
    .select({
      activeSources: sql<number>`(select count(*)::int from ${sourceDefinitions} where ${sourceDefinitions.workspaceId} = ${scope.workspaceId} and ${sourceDefinitions.tableId} = ${scope.tableId} and ${sourceDefinitions.status} = 'active')`,
      activeTables: sql<number>`(select count(*)::int from ${dataTables} where ${dataTables.workspaceId} = ${scope.workspaceId} and ${dataTables.archivedAt} is null)`,
      activeWebhooks: sql<number>`(select count(*)::int from ${webhookDestinations} where ${webhookDestinations.workspaceId} = ${scope.workspaceId} and ${webhookDestinations.tableId} = ${scope.tableId} and ${webhookDestinations.status} = 'active')`,
      activeWork: sql<number>`(
        (select count(*) from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.tableId} = ${scope.tableId} and ${cells.status} in ('queued', 'running')) +
        (select count(*) from ${importJobs} where ${importJobs.workspaceId} = ${scope.workspaceId} and ${importJobs.tableId} = ${scope.tableId} and ${importJobs.status} in ('staging', 'queued', 'running')) +
        (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId} and ${sourceRuns.tableId} = ${scope.tableId} and ${sourceRuns.status} in ('queued', 'running')) +
        (select count(*) from ${webhookDeliveries} where ${webhookDeliveries.workspaceId} = ${scope.workspaceId} and ${webhookDeliveries.tableId} = ${scope.tableId} and ${webhookDeliveries.status} in ('queued', 'running')) +
        (select count(*) from ${writebackDeliveries} where ${writebackDeliveries.workspaceId} = ${scope.workspaceId} and ${writebackDeliveries.tableId} = ${scope.tableId} and ${writebackDeliveries.status} in ('queued', 'running')) +
        (select count(*) from ${bulkRunBatches} where ${bulkRunBatches.workspaceId} = ${scope.workspaceId} and ${bulkRunBatches.tableId} = ${scope.tableId} and ${bulkRunBatches.status} in ('queued', 'running')) +
        (select count(*) from ${rowSettlements} where ${rowSettlements.workspaceId} = ${scope.workspaceId} and ${rowSettlements.tableId} = ${scope.tableId} and ${rowSettlements.status} in ('queued', 'running'))
      )::int`,
      activeWritebacks: sql<number>`(select count(*)::int from ${writebackDestinations} where ${writebackDestinations.workspaceId} = ${scope.workspaceId} and ${writebackDestinations.tableId} = ${scope.tableId} and ${writebackDestinations.status} = 'active')`,
      columns: sql<number>`(select count(*)::int from ${columns} where ${columns.workspaceId} = ${scope.workspaceId} and ${columns.tableId} = ${scope.tableId} and ${columns.archivedAt} is null)`,
      retainedRuns: sql<number>`(
        (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId} and ${sourceRuns.tableId} = ${scope.tableId}) +
        (select count(*) from ${webhookDeliveries} where ${webhookDeliveries.workspaceId} = ${scope.workspaceId} and ${webhookDeliveries.tableId} = ${scope.tableId}) +
        (select count(*) from ${writebackDeliveries} where ${writebackDeliveries.workspaceId} = ${scope.workspaceId} and ${writebackDeliveries.tableId} = ${scope.tableId}) +
        (select count(*) from ${bulkRunBatches} where ${bulkRunBatches.workspaceId} = ${scope.workspaceId} and ${bulkRunBatches.tableId} = ${scope.tableId})
      )::int`,
      rows: sql<number>`(select count(*)::int from ${rows} where ${rows.workspaceId} = ${scope.workspaceId} and ${rows.tableId} = ${scope.tableId} and ${rows.archivedAt} is null)`,
      savedViews: sql<number>`(select count(*)::int from ${savedGridViews} where ${savedGridViews.workspaceId} = ${scope.workspaceId} and ${savedGridViews.tableId} = ${scope.tableId})`,
    })
    .from(dataTables)
    .where(eq(dataTables.id, scope.tableId))
    .limit(1);
  if (!counts) throw new GridAccessError('The table is not accessible.');

  const blockers: SchemaLifecycleBlocker[] = [];
  pushBlocker(
    blockers,
    'last_table',
    counts.activeTables <= 1 ? 1 : 0,
    'A workspace must keep at least one active table.'
  );
  pushBlocker(
    blockers,
    'active_work',
    counts.activeWork,
    'Wait for queued and running work to finish or cancel it.'
  );
  pushBlocker(
    blockers,
    'active_sources',
    counts.activeSources,
    'Pause active scheduled sources before archiving this table.'
  );
  pushBlocker(
    blockers,
    'active_webhooks',
    counts.activeWebhooks,
    'Pause active webhook destinations before archiving this table.'
  );
  pushBlocker(
    blockers,
    'active_writebacks',
    counts.activeWritebacks,
    'Pause active writeback destinations before archiving this table.'
  );

  return {
    blockers,
    canArchive: blockers.length === 0,
    impact: {
      columns: counts.columns,
      retainedRuns: counts.retainedRuns,
      rows: counts.rows,
      savedViews: counts.savedViews,
    },
    table,
  };
}

async function buildColumnArchivePreview(
  db: LifecycleExecutor,
  scope: ColumnScope
): Promise<ColumnArchivePreview> {
  const table = await requireActiveTable(db, scope);
  const [column] = await db
    .select({ id: columns.id, kind: columns.kind, name: columns.name })
    .from(columns)
    .where(
      and(
        eq(columns.id, scope.columnId),
        eq(columns.workspaceId, scope.workspaceId),
        eq(columns.tableId, scope.tableId),
        isNull(columns.archivedAt)
      )
    )
    .limit(1);
  if (!column) throw new GridAccessError('The column is not accessible.');

  const [counts, dependents, sources, writebacks, views] = await Promise.all([
    db
      .select({
        activeColumns: sql<number>`(select count(*)::int from ${columns} where ${columns.workspaceId} = ${scope.workspaceId} and ${columns.tableId} = ${scope.tableId} and ${columns.archivedAt} is null)`,
        activeWork: sql<number>`(select count(*)::int from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.tableId} = ${scope.tableId} and ${cells.columnId} = ${scope.columnId} and ${cells.status} in ('queued', 'running'))`,
        cells: sql<number>`(select count(*)::int from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.tableId} = ${scope.tableId} and ${cells.columnId} = ${scope.columnId})`,
      })
      .from(columns)
      .where(eq(columns.id, scope.columnId))
      .limit(1)
      .then((items) => items[0]),
    db
      .select({ id: columns.id, name: columns.name })
      .from(columnDependencies)
      .innerJoin(columns, eq(columns.id, columnDependencies.columnId))
      .where(
        and(
          eq(columnDependencies.workspaceId, scope.workspaceId),
          eq(columnDependencies.tableId, scope.tableId),
          eq(columnDependencies.dependsOnColumnId, scope.columnId),
          isNull(columns.archivedAt)
        )
      ),
    db
      .select({
        fieldMapping: sourceDefinitions.fieldMapping,
        id: sourceDefinitions.id,
        status: sourceDefinitions.status,
      })
      .from(sourceDefinitions)
      .where(
        and(
          eq(sourceDefinitions.workspaceId, scope.workspaceId),
          eq(sourceDefinitions.tableId, scope.tableId)
        )
      ),
    db
      .select({
        fieldMappings: writebackDestinations.fieldMappings,
        filterTree: writebackDestinations.filterTree,
        id: writebackDestinations.id,
        recordIdColumnId: writebackDestinations.recordIdColumnId,
        status: writebackDestinations.status,
      })
      .from(writebackDestinations)
      .where(
        and(
          eq(writebackDestinations.workspaceId, scope.workspaceId),
          eq(writebackDestinations.tableId, scope.tableId)
        )
      ),
    db
      .select({ filters: savedGridViews.filters, sort: savedGridViews.sort })
      .from(savedGridViews)
      .where(
        and(
          eq(savedGridViews.workspaceId, scope.workspaceId),
          eq(savedGridViews.tableId, scope.tableId)
        )
      ),
  ]);
  if (!counts) throw new GridAccessError('The column is not accessible.');

  const mappedSources = sources.filter((source) =>
    (source.fieldMapping ?? []).some(
      (mapping) => mapping.columnId === scope.columnId
    )
  );
  const mappedWritebacks = writebacks.filter(
    (destination) =>
      destination.recordIdColumnId === scope.columnId ||
      destination.fieldMappings.some(
        (mapping) => mapping.columnId === scope.columnId
      ) ||
      gridViewFilterLeaves(
        normalizeGridViewFilterTree(destination.filterTree)
      ).some((filter) => filter.columnId === scope.columnId)
  );
  const activeSourceMappings = mappedSources.filter(
    (source) => source.status === 'active'
  );
  const activeWritebackMappings = mappedWritebacks.filter(
    (destination) => destination.status === 'active'
  );
  const referencingViews = views.filter(
    (view) =>
      view.sort?.columnId === scope.columnId ||
      gridViewFilterLeaves(normalizeGridViewFilterTree(view.filters)).some(
        (filter) => filter.columnId === scope.columnId
      )
  );

  const blockers: SchemaLifecycleBlocker[] = [];
  pushBlocker(
    blockers,
    'last_column',
    counts.activeColumns <= 1 ? 1 : 0,
    'A table must keep at least one active column.'
  );
  pushBlocker(
    blockers,
    'active_work',
    counts.activeWork,
    'Wait for queued and running cells in this column to finish or cancel them.'
  );
  pushBlocker(
    blockers,
    'dependent_columns',
    dependents.length,
    'Archive dependent columns first.'
  );
  pushBlocker(
    blockers,
    'source_mappings',
    activeSourceMappings.length,
    'Pause sources that map into this column before archiving it.'
  );
  pushBlocker(
    blockers,
    'writeback_mappings',
    activeWritebackMappings.length,
    'Pause writebacks that reference this column before archiving it.'
  );
  pushBlocker(
    blockers,
    'saved_views',
    referencingViews.length,
    'Update or delete saved views that reference this column before archiving it.'
  );

  return {
    blockers,
    canArchive: blockers.length === 0,
    column,
    impact: {
      cells: counts.cells,
      pausedSourceMappings: mappedSources.length - activeSourceMappings.length,
      pausedWritebackMappings:
        mappedWritebacks.length - activeWritebackMappings.length,
      savedViews: referencingViews.length,
    },
    table,
  };
}

async function requireSchemaManager(
  db: LifecycleExecutor,
  scope: WorkspaceScope
): Promise<WorkspaceRole> {
  const [membership] = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, scope.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .limit(1);
  if (
    !membership ||
    !hasWorkspacePermission(membership.role, 'schema.manage')
  ) {
    throw new GridAccessError('The schema is not accessible.');
  }
  return membership.role;
}

async function requireActiveTable(
  db: LifecycleExecutor,
  scope: TableScope
): Promise<{ id: string; name: string }> {
  const [table] = await db
    .select({ id: dataTables.id, name: dataTables.name })
    .from(dataTables)
    .where(
      and(
        eq(dataTables.id, scope.tableId),
        eq(dataTables.workspaceId, scope.workspaceId),
        isNull(dataTables.archivedAt)
      )
    )
    .limit(1);
  if (!table) throw new GridAccessError('The table is not accessible.');
  return table;
}

function requireConfirmation(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new GridValidationError(
      `Type “${expected}” exactly to confirm archival.`
    );
  }
}

function requireConversionConfirmation(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new GridValidationError(
      `Type “${expected}” exactly to confirm conversion.`
    );
  }
}

function requireNoBlockers(blockers: SchemaLifecycleBlocker[]): void {
  if (blockers.length > 0) {
    throw new GridConflictError(blockers.map((item) => item.message).join(' '));
  }
}

function pushBlocker(
  blockers: SchemaLifecycleBlocker[],
  code: SchemaLifecycleBlocker['code'],
  count: number,
  message: string
): void {
  if (count > 0) blockers.push({ code, count, message });
}

async function lockLifecycle(
  db: LifecycleExecutor,
  namespace: string
): Promise<void> {
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`
  );
}
