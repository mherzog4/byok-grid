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
} from '@byok-grid/domain';
import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import {
  deserializeSqliteCellValue,
  serializeSqliteCellValue,
} from './cell-values';
import {
  SqliteGridAccessError,
  SqliteGridConflictError,
  SqliteGridValidationError,
} from './grid-errors';
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

type SqliteLifecycleExecutor = Pick<
  SqliteDatabase,
  'insert' | 'select' | 'update'
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

export interface SqliteSchemaLifecycleBlocker {
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

export interface SqliteTableArchivePreview {
  blockers: SqliteSchemaLifecycleBlocker[];
  canArchive: boolean;
  impact: {
    columns: number;
    rows: number;
    savedViews: number;
    retainedRuns: number;
  };
  table: { id: string; name: string };
}

export interface SqliteColumnArchivePreview {
  blockers: SqliteSchemaLifecycleBlocker[];
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

export interface SqliteColumnTypeConversionFailure {
  code: string;
  message: string;
  rowId: string;
  rowPosition: string;
}

export interface SqliteColumnTypeConversionPreview {
  blockers: SqliteSchemaLifecycleBlocker[];
  canConvert: boolean;
  column: {
    id: string;
    kind: string;
    name: string;
    valueType: EditableInputValueType;
  };
  failures: SqliteColumnTypeConversionFailure[];
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

export interface SqliteArchivedTableSummary {
  archivedAt: Date;
  id: string;
  name: string;
}

export interface SqliteArchivedColumnSummary extends SqliteArchivedTableSummary {
  kind: string;
}

export async function listSqliteArchivedWorkspaceTables(
  db: SqliteDatabase,
  scope: WorkspaceScope
): Promise<SqliteArchivedTableSummary[]> {
  await requireSchemaManager(db, scope);
  const items = await db
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
    .orderBy(asc(dataTables.archivedAt));
  return items.map((item) => ({ ...item, archivedAt: item.archivedAt! }));
}

export async function listSqliteArchivedTableColumns(
  db: SqliteDatabase,
  scope: TableScope
): Promise<SqliteArchivedColumnSummary[]> {
  await requireSchemaManager(db, scope);
  await requireActiveTable(db, scope);
  const items = await db
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
    .orderBy(asc(columns.archivedAt));
  return items.map((item) => ({ ...item, archivedAt: item.archivedAt! }));
}

export async function previewSqliteTableArchive(
  db: SqliteDatabase,
  scope: TableScope
): Promise<SqliteTableArchivePreview> {
  await requireSchemaManager(db, scope);
  return buildTableArchivePreview(db, scope);
}

export async function archiveSqliteWorkspaceTable(
  db: SqliteDatabase,
  input: TableScope & { confirmationName: string },
  now = new Date()
) {
  const request = schemaArchiveRequestSchema.parse({
    confirmationName: input.confirmationName,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireSchemaManager(tx, input);
    const preview = await buildTableArchivePreview(tx, input);
    requireArchiveConfirmation(request.confirmationName, preview.table.name);
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
    if (!archived) {
      throw new SqliteGridAccessError('The table is not accessible.');
    }
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

export async function restoreSqliteWorkspaceTable(
  db: SqliteDatabase,
  input: TableScope,
  now = new Date()
) {
  return withSqliteWriteTransaction(db, async (tx) => {
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
    if (!table?.archivedAt) {
      throw new SqliteGridAccessError('The archived table is not accessible.');
    }
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

export async function previewSqliteColumnArchive(
  db: SqliteDatabase,
  scope: ColumnScope
): Promise<SqliteColumnArchivePreview> {
  await requireSchemaManager(db, scope);
  return buildColumnArchivePreview(db, scope);
}

export async function archiveSqliteWorkspaceColumn(
  db: SqliteDatabase,
  input: ColumnScope & { confirmationName: string },
  now = new Date()
) {
  const request = schemaArchiveRequestSchema.parse({
    confirmationName: input.confirmationName,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireSchemaManager(tx, input);
    const preview = await buildColumnArchivePreview(tx, input);
    requireArchiveConfirmation(request.confirmationName, preview.column.name);
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
    if (!archived) {
      throw new SqliteGridAccessError('The column is not accessible.');
    }
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

export async function restoreSqliteWorkspaceColumn(
  db: SqliteDatabase,
  input: ColumnScope,
  now = new Date()
) {
  return withSqliteWriteTransaction(db, async (tx) => {
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
    if (!column?.archivedAt) {
      throw new SqliteGridAccessError('The archived column is not accessible.');
    }
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
      throw new SqliteGridConflictError(
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

export async function previewSqliteColumnTypeConversion(
  db: SqliteDatabase,
  input: ColumnScope & { targetType: EditableInputValueType }
): Promise<SqliteColumnTypeConversionPreview> {
  const request = columnTypeConversionPreviewRequestSchema.parse({
    targetType: input.targetType,
  });
  await requireSchemaManager(db, input);
  return buildColumnTypeConversionPreview(db, {
    ...input,
    targetType: request.targetType,
  });
}

export async function convertSqliteWorkspaceColumnType(
  db: SqliteDatabase,
  input: ColumnScope & {
    confirmationName: string;
    previewDigest: string;
    targetType: EditableInputValueType;
  },
  now = new Date()
) {
  const request = columnTypeConversionRequestSchema.parse({
    confirmationName: input.confirmationName,
    previewDigest: input.previewDigest,
    targetType: input.targetType,
  });
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireSchemaManager(tx, input);
    const preview = await buildColumnTypeConversionPreview(tx, {
      ...input,
      targetType: request.targetType,
    });
    requireConversionConfirmation(
      request.confirmationName,
      preview.column.name
    );
    if (preview.previewDigest !== request.previewDigest) {
      throw new SqliteGridConflictError(
        'The column changed after the preview. Review the conversion again.'
      );
    }
    requireNoBlockers(preview.blockers);
    const convertedCells = await applyColumnTypeConversion(
      tx,
      { ...input, targetType: request.targetType },
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
      throw new SqliteGridConflictError(
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

const CONVERSION_PAGE_SIZE = 1_000;
const FAILURE_SAMPLE_SIZE = 10;

async function buildColumnTypeConversionPreview(
  db: SqliteLifecycleExecutor,
  scope: ColumnScope & { targetType: EditableInputValueType }
): Promise<SqliteColumnTypeConversionPreview> {
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
  if (!storedColumn) {
    throw new SqliteGridAccessError('The column is not accessible.');
  }
  if (storedColumn.kind !== 'input' || storedColumn.valueType === 'empty') {
    throw new SqliteGridValidationError(
      'Only typed input columns can be converted.'
    );
  }
  const column = {
    ...storedColumn,
    valueType: storedColumn.valueType as EditableInputValueType,
  };
  if (column.valueType === scope.targetType) {
    throw new SqliteGridValidationError(
      `The column already uses the ${scope.targetType} type.`
    );
  }

  const activeWork = await countActiveColumnConversionWork(db, scope);
  const dependents = await db
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
    );
  const sources = await selectSourceMappings(db, scope);
  const ingestion = await selectIngestionMappings(db, scope);
  const writebacks = await selectWritebackMappings(db, scope);
  const views = await selectSavedViewMappings(db, scope);
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
  const referencingWritebacks = writebacks.filter((destination) =>
    writebackReferencesColumn(destination, scope.columnId)
  );
  const referencingViews = views.filter((view) =>
    viewReferencesColumn(view, scope.columnId)
  );
  const scan = await scanColumnTypeConversion(db, scope, column.valueType);
  const blockers: SqliteSchemaLifecycleBlocker[] = [];
  pushBlocker(
    blockers,
    'active_work',
    activeWork,
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
  db: SqliteLifecycleExecutor,
  scope: ColumnScope & { targetType: EditableInputValueType },
  currentType: EditableInputValueType
) {
  const digest = createHash('sha256');
  digest.update(
    `column-conversion-v1\0${scope.workspaceId}\0${scope.tableId}\0${scope.columnId}\0${currentType}\0${scope.targetType}\0`
  );
  const failures: SqliteColumnTypeConversionFailure[] = [];
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
      .limit(CONVERSION_PAGE_SIZE);
    for (const { cell, rowPosition } of page) {
      impact.totalCells += 1;
      digest.update(`${cell.id}\0${cell.version}\0${cell.valueType}\0`);
      if (cell.valueType === 'empty') {
        impact.emptyCells += 1;
        continue;
      }
      let failure: { code: string; message: string } | null = null;
      if (cell.valueType !== currentType) {
        failure = {
          code: 'stored_type_mismatch',
          message: `The stored ${cell.valueType} value does not match the column's ${currentType} type.`,
        };
      } else {
        try {
          convertColumnCellValue(
            deserializeSqliteCellValue(cell),
            scope.targetType
          );
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
        if (failures.length < FAILURE_SAMPLE_SIZE) {
          failures.push({
            ...failure,
            rowId: cell.rowId,
            rowPosition,
          });
        }
      }
    }
    if (page.length < CONVERSION_PAGE_SIZE) break;
    lastCellId = page.at(-1)!.cell.id;
  }
  return { digest, failures, impact };
}

async function applyColumnTypeConversion(
  db: SqliteLifecycleExecutor,
  scope: ColumnScope & { targetType: EditableInputValueType },
  now: Date
): Promise<number> {
  const storedCells = await db
    .select()
    .from(cells)
    .where(
      and(
        eq(cells.workspaceId, scope.workspaceId),
        eq(cells.tableId, scope.tableId),
        eq(cells.columnId, scope.columnId),
        sql`${cells.valueType} <> 'empty'`
      )
    )
    .orderBy(asc(cells.id));
  for (const cell of storedCells) {
    const serialized = serializeSqliteCellValue(
      convertColumnCellValue(deserializeSqliteCellValue(cell), scope.targetType)
    );
    await db
      .update(cells)
      .set({
        ...serialized,
        status: 'idle',
        updatedAt: now,
        version: sql`${cells.version} + 1`,
      })
      .where(eq(cells.id, cell.id));
  }
  return storedCells.length;
}

async function buildTableArchivePreview(
  db: SqliteLifecycleExecutor,
  scope: TableScope
): Promise<SqliteTableArchivePreview> {
  const table = await requireActiveTable(db, scope);
  const [counts] = await db
    .select({
      activeIngestion: sql<number>`(select count(*) from ${ingestionEndpoints} where ${ingestionEndpoints.workspaceId} = ${scope.workspaceId} and ${ingestionEndpoints.tableId} = ${scope.tableId} and ${ingestionEndpoints.revokedAt} is null)`,
      activeSources: sql<number>`(select count(*) from ${sourceDefinitions} where ${sourceDefinitions.workspaceId} = ${scope.workspaceId} and ${sourceDefinitions.tableId} = ${scope.tableId} and ${sourceDefinitions.status} = 'active')`,
      activeTables: sql<number>`(select count(*) from ${dataTables} where ${dataTables.workspaceId} = ${scope.workspaceId} and ${dataTables.archivedAt} is null)`,
      activeWebhooks: sql<number>`(select count(*) from ${webhookDestinations} where ${webhookDestinations.workspaceId} = ${scope.workspaceId} and ${webhookDestinations.tableId} = ${scope.tableId} and ${webhookDestinations.status} = 'active')`,
      activeWork: sql<number>`
        (select count(*) from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.tableId} = ${scope.tableId} and ${cells.status} in ('queued', 'running')) +
        (select count(*) from ${importJobs} where ${importJobs.workspaceId} = ${scope.workspaceId} and ${importJobs.tableId} = ${scope.tableId} and ${importJobs.status} in ('staging', 'queued', 'running')) +
        (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId} and ${sourceRuns.tableId} = ${scope.tableId} and ${sourceRuns.status} in ('queued', 'running')) +
        (select count(*) from ${ingestionBatches} where ${ingestionBatches.workspaceId} = ${scope.workspaceId} and ${ingestionBatches.tableId} = ${scope.tableId} and ${ingestionBatches.status} in ('queued', 'running')) +
        (select count(*) from ${webhookDeliveries} where ${webhookDeliveries.workspaceId} = ${scope.workspaceId} and ${webhookDeliveries.tableId} = ${scope.tableId} and ${webhookDeliveries.status} in ('queued', 'running')) +
        (select count(*) from ${writebackDeliveries} where ${writebackDeliveries.workspaceId} = ${scope.workspaceId} and ${writebackDeliveries.tableId} = ${scope.tableId} and ${writebackDeliveries.status} in ('queued', 'running')) +
        (select count(*) from ${bulkRunBatches} where ${bulkRunBatches.workspaceId} = ${scope.workspaceId} and ${bulkRunBatches.tableId} = ${scope.tableId} and ${bulkRunBatches.status} in ('queued', 'running')) +
        (select count(*) from ${rowSettlements} where ${rowSettlements.workspaceId} = ${scope.workspaceId} and ${rowSettlements.tableId} = ${scope.tableId} and ${rowSettlements.status} in ('queued', 'running'))`,
      activeWritebacks: sql<number>`(select count(*) from ${writebackDestinations} where ${writebackDestinations.workspaceId} = ${scope.workspaceId} and ${writebackDestinations.tableId} = ${scope.tableId} and ${writebackDestinations.status} = 'active')`,
      columns: sql<number>`(select count(*) from ${columns} where ${columns.workspaceId} = ${scope.workspaceId} and ${columns.tableId} = ${scope.tableId} and ${columns.archivedAt} is null)`,
      retainedRuns: sql<number>`
        (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId} and ${sourceRuns.tableId} = ${scope.tableId}) +
        (select count(*) from ${webhookDeliveries} where ${webhookDeliveries.workspaceId} = ${scope.workspaceId} and ${webhookDeliveries.tableId} = ${scope.tableId}) +
        (select count(*) from ${writebackDeliveries} where ${writebackDeliveries.workspaceId} = ${scope.workspaceId} and ${writebackDeliveries.tableId} = ${scope.tableId}) +
        (select count(*) from ${bulkRunBatches} where ${bulkRunBatches.workspaceId} = ${scope.workspaceId} and ${bulkRunBatches.tableId} = ${scope.tableId})`,
      rows: sql<number>`(select count(*) from ${rows} where ${rows.workspaceId} = ${scope.workspaceId} and ${rows.tableId} = ${scope.tableId} and ${rows.archivedAt} is null)`,
      savedViews: sql<number>`(select count(*) from ${savedGridViews} where ${savedGridViews.workspaceId} = ${scope.workspaceId} and ${savedGridViews.tableId} = ${scope.tableId})`,
    })
    .from(dataTables)
    .where(eq(dataTables.id, scope.tableId))
    .limit(1);
  if (!counts) {
    throw new SqliteGridAccessError('The table is not accessible.');
  }
  const blockers: SqliteSchemaLifecycleBlocker[] = [];
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
    'active_ingestion',
    counts.activeIngestion,
    'Revoke active ingestion endpoints before archiving this table.'
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
  db: SqliteLifecycleExecutor,
  scope: ColumnScope
): Promise<SqliteColumnArchivePreview> {
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
  if (!column) {
    throw new SqliteGridAccessError('The column is not accessible.');
  }
  const [counts] = await db
    .select({
      activeColumns: sql<number>`(select count(*) from ${columns} where ${columns.workspaceId} = ${scope.workspaceId} and ${columns.tableId} = ${scope.tableId} and ${columns.archivedAt} is null)`,
      activeWork: sql<number>`(select count(*) from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.tableId} = ${scope.tableId} and ${cells.columnId} = ${scope.columnId} and ${cells.status} in ('queued', 'running'))`,
      cells: sql<number>`(select count(*) from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.tableId} = ${scope.tableId} and ${cells.columnId} = ${scope.columnId})`,
    })
    .from(columns)
    .where(eq(columns.id, scope.columnId))
    .limit(1);
  if (!counts) {
    throw new SqliteGridAccessError('The column is not accessible.');
  }
  const dependents = await db
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
    );
  const sources = await selectSourceMappings(db, scope);
  const ingestion = await selectIngestionMappings(db, scope);
  const writebacks = await selectWritebackMappings(db, scope);
  const views = await selectSavedViewMappings(db, scope);
  const mappedSources = sources.filter((source) =>
    (source.fieldMapping ?? []).some(
      (mapping) => mapping.columnId === scope.columnId
    )
  );
  const activeSourceMappings = mappedSources.filter(
    (source) => source.status === 'active'
  );
  const activeIngestionMappings = ingestion.filter(
    (endpoint) =>
      !endpoint.revokedAt &&
      (endpoint.fieldMapping ?? []).some(
        (mapping) => mapping.columnId === scope.columnId
      )
  );
  const mappedWritebacks = writebacks.filter((destination) =>
    writebackReferencesColumn(destination, scope.columnId)
  );
  const activeWritebackMappings = mappedWritebacks.filter(
    (destination) => destination.status === 'active'
  );
  const referencingViews = views.filter((view) =>
    viewReferencesColumn(view, scope.columnId)
  );
  const blockers: SqliteSchemaLifecycleBlocker[] = [];
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
    'active_ingestion',
    activeIngestionMappings.length,
    'Revoke ingestion endpoints that map into this column before archiving it.'
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

async function countActiveColumnConversionWork(
  db: SqliteLifecycleExecutor,
  scope: ColumnScope
): Promise<number> {
  const [result] = await db
    .select({
      value: sql<number>`
        (select count(*) from ${cells} where ${cells.workspaceId} = ${scope.workspaceId} and ${cells.tableId} = ${scope.tableId} and ${cells.columnId} = ${scope.columnId} and ${cells.status} in ('queued', 'running')) +
        (select count(*) from ${importJobs} where ${importJobs.workspaceId} = ${scope.workspaceId} and ${importJobs.tableId} = ${scope.tableId} and ${importJobs.status} in ('staging', 'queued', 'running')) +
        (select count(*) from ${sourceRuns} where ${sourceRuns.workspaceId} = ${scope.workspaceId} and ${sourceRuns.tableId} = ${scope.tableId} and ${sourceRuns.status} in ('queued', 'running')) +
        (select count(*) from ${ingestionBatches} where ${ingestionBatches.workspaceId} = ${scope.workspaceId} and ${ingestionBatches.tableId} = ${scope.tableId} and ${ingestionBatches.status} in ('queued', 'running'))`,
    })
    .from(columns)
    .where(eq(columns.id, scope.columnId))
    .limit(1);
  return result?.value ?? 0;
}

function selectSourceMappings(db: SqliteLifecycleExecutor, scope: TableScope) {
  return db
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
    );
}

function selectIngestionMappings(
  db: SqliteLifecycleExecutor,
  scope: TableScope
) {
  return db
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
    );
}

function selectWritebackMappings(
  db: SqliteLifecycleExecutor,
  scope: TableScope
) {
  return db
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
    );
}

function selectSavedViewMappings(
  db: SqliteLifecycleExecutor,
  scope: TableScope
) {
  return db
    .select({ filters: savedGridViews.filters, sort: savedGridViews.sort })
    .from(savedGridViews)
    .where(
      and(
        eq(savedGridViews.workspaceId, scope.workspaceId),
        eq(savedGridViews.tableId, scope.tableId)
      )
    );
}

function writebackReferencesColumn(
  destination: Awaited<ReturnType<typeof selectWritebackMappings>>[number],
  columnId: string
): boolean {
  return (
    destination.recordIdColumnId === columnId ||
    destination.fieldMappings.some(
      (mapping) => mapping.columnId === columnId
    ) ||
    gridViewFilterLeaves(
      normalizeGridViewFilterTree(destination.filterTree)
    ).some((filter) => filter.columnId === columnId)
  );
}

function viewReferencesColumn(
  view: Awaited<ReturnType<typeof selectSavedViewMappings>>[number],
  columnId: string
): boolean {
  return (
    view.sort?.columnId === columnId ||
    gridViewFilterLeaves(normalizeGridViewFilterTree(view.filters)).some(
      (filter) => filter.columnId === columnId
    )
  );
}

async function requireSchemaManager(
  db: SqliteLifecycleExecutor,
  scope: WorkspaceScope
): Promise<void> {
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
    throw new SqliteGridAccessError('The schema is not accessible.');
  }
}

async function requireActiveTable(
  db: SqliteLifecycleExecutor,
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
  if (!table) {
    throw new SqliteGridAccessError('The table is not accessible.');
  }
  return table;
}

function requireArchiveConfirmation(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SqliteGridValidationError(
      `Type “${expected}” exactly to confirm archival.`
    );
  }
}

function requireConversionConfirmation(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new SqliteGridValidationError(
      `Type “${expected}” exactly to confirm conversion.`
    );
  }
}

function requireNoBlockers(blockers: SqliteSchemaLifecycleBlocker[]): void {
  if (blockers.length > 0) {
    throw new SqliteGridConflictError(
      blockers.map((item) => item.message).join(' ')
    );
  }
}

function pushBlocker(
  blockers: SqliteSchemaLifecycleBlocker[],
  code: SqliteSchemaLifecycleBlocker['code'],
  count: number,
  message: string
): void {
  if (count > 0) blockers.push({ code, count, message });
}
