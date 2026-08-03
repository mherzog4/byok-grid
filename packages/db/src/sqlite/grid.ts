import {
  connectorRunModeSchema,
  editableCellValueSchema,
  gridSearchQuerySchema,
  type CellValue,
  type ConnectorRunMode,
} from '@byok-grid/domain';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
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
import { recomputeDependentSqliteFormulasForRow } from './formulas';
import {
  buildSqliteGridViewFilterTreePredicate,
  sqliteGridViewSortExpressions,
  type SqliteGridColumnValueType,
} from './grid-view-query';
import {
  getSqliteSavedGridView,
  type SqliteSavedGridViewSummary,
} from './grid-views';
import { recordSqliteRowMutationAndMaybeQueueSettlement } from './row-mutations';
import { cells, columns, dataTables, rows, workspaceMembers } from './schema';

export interface SqliteGridCell {
  id: string;
  status: (typeof cells.$inferSelect)['status'];
  value: CellValue;
  version: number;
}

export interface SqliteGridRow {
  cells: Record<string, SqliteGridCell>;
  id: string;
  position: string;
  version: number;
}

export interface SqliteGridSnapshot {
  activeView: { id: string; name: string } | null;
  columns: Array<{
    id: string;
    kind: (typeof columns.$inferSelect)['kind'];
    name: string;
    position: string;
    runMode: ConnectorRunMode | null;
    valueType: (typeof columns.$inferSelect)['valueType'];
  }>;
  pageInfo: { hasMore: boolean; nextCursor: string | null };
  rows: SqliteGridRow[];
  searchQuery: string | null;
  table: { id: string; name: string };
  workspaceId: string;
}

interface GridScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

interface PositionGridCursor {
  id: string;
  kind: 'position';
  position: string;
  searchQuery: string | null;
}

interface SortedGridCursor {
  columnId: string;
  direction: 'asc' | 'desc';
  empty: boolean;
  kind: 'sorted';
  rowId: string;
  searchQuery: string | null;
  value: boolean | string | null;
  viewId: string;
}

type SqliteGridCursor = PositionGridCursor | SortedGridCursor;

interface SelectedSqliteGridRow {
  id: string;
  position: string;
  sortEmpty?: boolean;
  sortValue?: unknown;
  version: number;
}

export async function listSqliteWorkspaceTables(
  db: SqliteDatabase,
  scope: Pick<GridScope, 'userId' | 'workspaceId'>
): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: dataTables.id, name: dataTables.name })
    .from(dataTables)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, dataTables.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(
      and(
        eq(dataTables.workspaceId, scope.workspaceId),
        isNull(dataTables.archivedAt)
      )
    )
    .orderBy(asc(dataTables.createdAt), asc(dataTables.id));
}

export async function getSqliteGridSnapshot(
  db: SqliteDatabase,
  scope: GridScope,
  options: {
    cursor?: string | null;
    limit?: number;
    searchQuery?: string | null;
    viewId?: string | null;
  } = {}
): Promise<SqliteGridSnapshot> {
  const table = await requireTableAccess(db, scope);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  const searchQuery = parseGridSearchQuery(options.searchQuery);
  const cursor = options.cursor ? decodeGridCursor(options.cursor) : null;
  const activeView = options.viewId
    ? await getSqliteSavedGridView(db, { ...scope, viewId: options.viewId })
    : null;

  const gridColumns = await db
    .select({
      configuration: columns.configuration,
      id: columns.id,
      kind: columns.kind,
      name: columns.name,
      position: columns.position,
      valueType: columns.valueType,
    })
    .from(columns)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, columns.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(
      and(
        eq(columns.workspaceId, scope.workspaceId),
        eq(columns.tableId, scope.tableId),
        isNull(columns.archivedAt)
      )
    )
    .orderBy(asc(columns.position));
  const valueTypes = new Map(
    gridColumns.map((column) => [column.id, column.valueType])
  );

  const selectedRows = await selectSqliteGridRows(
    db,
    scope,
    activeView,
    cursor,
    limit + 1,
    searchQuery,
    valueTypes
  );
  const hasMore = selectedRows.length > limit;
  const gridRows = selectedRows.slice(0, limit);
  const rowIds = gridRows.map((row) => row.id);
  const gridCells =
    rowIds.length === 0
      ? []
      : await db
          .select({ cell: cells })
          .from(cells)
          .innerJoin(
            workspaceMembers,
            and(
              eq(workspaceMembers.workspaceId, cells.workspaceId),
              eq(workspaceMembers.userId, scope.userId)
            )
          )
          .where(
            and(
              eq(cells.workspaceId, scope.workspaceId),
              eq(cells.tableId, scope.tableId),
              inArray(cells.rowId, rowIds)
            )
          );

  const rowMap = new Map(
    gridRows.map((row) => [
      row.id,
      {
        cells: {} as Record<string, SqliteGridCell>,
        id: row.id,
        position: row.position,
        version: row.version,
      },
    ])
  );
  for (const { cell } of gridCells) {
    const row = rowMap.get(cell.rowId);
    if (row) row.cells[cell.columnId] = toGridCell(cell);
  }

  return {
    activeView: activeView
      ? { id: activeView.id, name: activeView.name }
      : null,
    columns: gridColumns.map(({ configuration, ...column }) => ({
      ...column,
      runMode:
        column.kind === 'connector'
          ? readConnectorRunMode(configuration)
          : null,
    })),
    pageInfo: {
      hasMore,
      nextCursor:
        hasMore && gridRows.length > 0
          ? encodeGridCursor(
              gridRows.at(-1)!,
              activeView,
              searchQuery,
              valueTypes
            )
          : null,
    },
    rows: [...rowMap.values()],
    searchQuery,
    table,
    workspaceId: scope.workspaceId,
  };
}

async function selectSqliteGridRows(
  db: SqliteDatabase,
  scope: GridScope,
  activeView: SqliteSavedGridViewSummary | null,
  cursor: SqliteGridCursor | null,
  limit: number,
  searchQuery: string | null,
  valueTypes: ReadonlyMap<string, SqliteGridColumnValueType>
): Promise<SelectedSqliteGridRow[]> {
  const filterPredicate = activeView
    ? buildSqliteGridViewFilterTreePredicate(activeView.filterTree)
    : undefined;
  const searchPredicate = buildSqliteGridSearchPredicate(searchQuery);
  if (cursor && cursor.searchQuery !== searchQuery) {
    throw new SqliteGridValidationError(
      'The cursor does not match this search.'
    );
  }

  if (!activeView?.sort) {
    if (cursor?.kind === 'sorted') {
      throw new SqliteGridValidationError(
        'The cursor does not match this view.'
      );
    }
    return db
      .select({ id: rows.id, position: rows.position, version: rows.version })
      .from(rows)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, rows.workspaceId),
          eq(workspaceMembers.userId, scope.userId)
        )
      )
      .where(
        and(
          eq(rows.workspaceId, scope.workspaceId),
          eq(rows.tableId, scope.tableId),
          isNull(rows.archivedAt),
          filterPredicate,
          searchPredicate,
          cursor
            ? or(
                gt(rows.position, cursor.position),
                and(eq(rows.position, cursor.position), gt(rows.id, cursor.id))
              )
            : undefined
        )
      )
      .orderBy(asc(rows.position), asc(rows.id))
      .limit(limit);
  }

  const sort = activeView.sort;
  const valueType = valueTypes.get(sort.columnId);
  if (!valueType || valueType === 'empty' || valueType === 'json') {
    throw new SqliteGridValidationError(
      'The saved-view sort column is invalid.'
    );
  }
  if (
    cursor &&
    (cursor.kind !== 'sorted' ||
      cursor.viewId !== activeView.id ||
      cursor.columnId !== sort.columnId ||
      cursor.direction !== sort.direction)
  ) {
    throw new SqliteGridValidationError('The cursor does not match this view.');
  }

  const sortCells = alias(cells, 'saved_view_sort_cell');
  const { sortEmpty, sortValue } = sqliteGridViewSortExpressions(
    sortCells,
    valueType
  );
  const cursorPredicate =
    cursor?.kind === 'sorted'
      ? buildSortedCursorPredicate(cursor, sortEmpty, sortValue, valueType)
      : undefined;
  return db
    .select({
      id: rows.id,
      position: rows.position,
      sortEmpty,
      sortValue,
      version: rows.version,
    })
    .from(rows)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, rows.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .leftJoin(
      sortCells,
      and(
        eq(sortCells.workspaceId, rows.workspaceId),
        eq(sortCells.tableId, rows.tableId),
        eq(sortCells.rowId, rows.id),
        eq(sortCells.columnId, sort.columnId)
      )
    )
    .where(
      and(
        eq(rows.workspaceId, scope.workspaceId),
        eq(rows.tableId, scope.tableId),
        isNull(rows.archivedAt),
        filterPredicate,
        searchPredicate,
        cursorPredicate
      )
    )
    .orderBy(
      asc(sortEmpty),
      sort.direction === 'asc' ? asc(sortValue) : desc(sortValue),
      sort.direction === 'asc' ? asc(rows.id) : desc(rows.id)
    )
    .limit(limit);
}

function buildSortedCursorPredicate(
  cursor: SortedGridCursor,
  sortEmpty: SQL<boolean>,
  sortValue: SQL<unknown>,
  valueType: Exclude<SqliteGridColumnValueType, 'empty' | 'json'>
): SQL {
  const rowAfter =
    cursor.direction === 'asc'
      ? gt(rows.id, cursor.rowId)
      : lt(rows.id, cursor.rowId);
  if (cursor.empty) {
    return and(sql`${sortEmpty} = 1`, rowAfter)!;
  }
  if (cursor.value === null) {
    throw new SqliteGridValidationError('The cursor is invalid.');
  }
  const value = parseSortedCursorValue(cursor.value, valueType);
  const valueAfter =
    cursor.direction === 'asc'
      ? sql`${sortValue} > ${value}`
      : sql`${sortValue} < ${value}`;
  return or(
    and(
      sql`${sortEmpty} = 0`,
      or(valueAfter, and(sql`${sortValue} = ${value}`, rowAfter))
    ),
    sql`${sortEmpty} = 1`
  )!;
}

function parseSortedCursorValue(
  value: boolean | string,
  valueType: Exclude<SqliteGridColumnValueType, 'empty' | 'json'>
): boolean | number | string {
  switch (valueType) {
    case 'text':
      if (typeof value !== 'string') {
        throw new SqliteGridValidationError('The cursor is invalid.');
      }
      return value;
    case 'number': {
      const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed)) {
        throw new SqliteGridValidationError('The cursor is invalid.');
      }
      return parsed;
    }
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw new SqliteGridValidationError('The cursor is invalid.');
      }
      return value ? 1 : 0;
    case 'timestamp': {
      const parsed = typeof value === 'string' ? new Date(value) : new Date('');
      if (Number.isNaN(parsed.getTime())) {
        throw new SqliteGridValidationError('The cursor is invalid.');
      }
      return parsed.getTime();
    }
  }
}

export async function getSqliteGridRow(
  db: SqliteDatabase,
  scope: GridScope & { rowId: string }
): Promise<SqliteGridRow> {
  await requireTableAccess(db, scope);
  const [row] = await db
    .select({ id: rows.id, position: rows.position, version: rows.version })
    .from(rows)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, rows.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(
      and(
        eq(rows.id, scope.rowId),
        eq(rows.tableId, scope.tableId),
        eq(rows.workspaceId, scope.workspaceId),
        isNull(rows.archivedAt)
      )
    )
    .limit(1);
  if (!row) throw new SqliteGridAccessError('The row is not accessible.');

  const rowCells = await db
    .select({ cell: cells })
    .from(cells)
    .innerJoin(
      columns,
      and(
        eq(columns.id, cells.columnId),
        eq(columns.tableId, cells.tableId),
        eq(columns.workspaceId, cells.workspaceId)
      )
    )
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, cells.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(
      and(
        eq(cells.rowId, row.id),
        eq(cells.tableId, scope.tableId),
        eq(cells.workspaceId, scope.workspaceId),
        isNull(columns.archivedAt)
      )
    );
  return {
    ...row,
    cells: Object.fromEntries(
      rowCells.map(({ cell }) => [cell.columnId, toGridCell(cell)])
    ),
  };
}

export async function createSqliteGridRow(
  db: SqliteDatabase,
  scope: GridScope
): Promise<{ id: string; position: string; version: number }> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTableAccess(tx, scope);
    const position = `${Date.now().toString().padStart(13, '0')}-${crypto.randomUUID()}`;
    const [row] = await tx
      .insert(rows)
      .values({
        position,
        tableId: scope.tableId,
        workspaceId: scope.workspaceId,
      })
      .returning({
        id: rows.id,
        position: rows.position,
        version: rows.version,
      });
    if (!row) throw new Error('The row could not be created.');
    return row;
  });
}

export async function writeSqliteGridCell(
  db: SqliteDatabase,
  scope: GridScope & {
    columnId: string;
    expectedVersion: number;
    rowId: string;
    value: CellValue;
  }
): Promise<SqliteGridCell> {
  const value = editableCellValueSchema.parse(scope.value);

  return withSqliteWriteTransaction(db, async (tx) => {
    const [target] = await tx
      .select({
        columnKind: columns.kind,
        columnValueType: columns.valueType,
        rowId: rows.id,
      })
      .from(rows)
      .innerJoin(
        columns,
        and(
          eq(columns.id, scope.columnId),
          eq(columns.tableId, rows.tableId),
          eq(columns.workspaceId, rows.workspaceId),
          isNull(columns.archivedAt)
        )
      )
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, rows.workspaceId),
          eq(workspaceMembers.userId, scope.userId)
        )
      )
      .where(
        and(
          eq(rows.id, scope.rowId),
          eq(rows.tableId, scope.tableId),
          eq(rows.workspaceId, scope.workspaceId),
          isNull(rows.archivedAt)
        )
      )
      .limit(1);
    if (!target) throw new SqliteGridAccessError('The cell is not accessible.');
    if (target.columnKind !== 'input') {
      throw new SqliteGridValidationError('Only input columns can be edited.');
    }
    if (value.type !== 'empty' && value.type !== target.columnValueType) {
      throw new SqliteGridValidationError(
        `This column requires ${target.columnValueType} values.`
      );
    }

    const [existing] = await tx
      .select({ id: cells.id, version: cells.version })
      .from(cells)
      .where(
        and(
          eq(cells.workspaceId, scope.workspaceId),
          eq(cells.tableId, scope.tableId),
          eq(cells.rowId, scope.rowId),
          eq(cells.columnId, scope.columnId)
        )
      )
      .limit(1);
    const serialized = serializeSqliteCellValue(value);

    let written: typeof cells.$inferSelect;
    if (!existing) {
      if (scope.expectedVersion !== 0) throw new SqliteGridConflictError();
      const [created] = await tx
        .insert(cells)
        .values({
          ...serialized,
          columnId: scope.columnId,
          rowId: scope.rowId,
          tableId: scope.tableId,
          workspaceId: scope.workspaceId,
        })
        .returning();
      if (!created) throw new Error('The cell could not be created.');
      written = created;
    } else {
      const [updated] = await tx
        .update(cells)
        .set({
          ...serialized,
          status: 'idle',
          updatedAt: new Date(),
          version: sql`${cells.version} + 1`,
        })
        .where(
          and(
            eq(cells.id, existing.id),
            eq(cells.workspaceId, scope.workspaceId),
            eq(cells.version, scope.expectedVersion)
          )
        )
        .returning();
      if (!updated) throw new SqliteGridConflictError();
      written = updated;
    }

    const changedFormulaIds = await recomputeDependentSqliteFormulasForRow(tx, {
      changedColumnIds: [scope.columnId],
      rowId: scope.rowId,
      tableId: scope.tableId,
      workspaceId: scope.workspaceId,
    });
    await recordSqliteRowMutationAndMaybeQueueSettlement(tx, {
      changedColumnIds: [scope.columnId, ...changedFormulaIds],
      rowId: scope.rowId,
      tableId: scope.tableId,
      workspaceId: scope.workspaceId,
    });
    return toGridCell(written);
  });
}

function readConnectorRunMode(
  configuration: Readonly<Record<string, unknown>>
): ConnectorRunMode {
  const parsed = connectorRunModeSchema.safeParse(configuration.runMode);
  return parsed.success ? parsed.data : 'manual';
}

async function requireTableAccess(
  db: Pick<SqliteDatabase, 'select'>,
  scope: GridScope
) {
  const [table] = await db
    .select({ id: dataTables.id, name: dataTables.name })
    .from(dataTables)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, dataTables.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
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

function toGridCell(cell: typeof cells.$inferSelect): SqliteGridCell {
  return {
    id: cell.id,
    status: cell.status,
    value: deserializeSqliteCellValue(cell),
    version: cell.version,
  };
}

export function buildSqliteGridSearchPredicate(
  searchQuery: string | null
): SQL | undefined {
  if (searchQuery === null) return undefined;
  const escaped = searchQuery
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
  const pattern = `%${escaped}%`;
  return sql`exists (
    select 1
    from cells_search_fts
    join cells as search_cells
      on search_cells.rowid = cells_search_fts.rowid
    where search_cells.workspace_id = ${rows.workspaceId}
      and search_cells.table_id = ${rows.tableId}
      and search_cells.row_id = ${rows.id}
      and cells_search_fts.search_text like ${pattern} escape '\\'
  )`;
}

function encodeGridCursor(
  row: SelectedSqliteGridRow,
  activeView: SqliteSavedGridViewSummary | null,
  searchQuery: string | null,
  valueTypes: ReadonlyMap<string, SqliteGridColumnValueType>
): string {
  if (activeView?.sort) {
    const valueType = valueTypes.get(activeView.sort.columnId);
    if (!valueType || valueType === 'empty' || valueType === 'json') {
      throw new SqliteGridValidationError(
        'The saved-view sort column is invalid.'
      );
    }
    const empty = Boolean(row.sortEmpty ?? true);
    return Buffer.from(
      JSON.stringify({
        columnId: activeView.sort.columnId,
        direction: activeView.sort.direction,
        empty,
        kind: 'sorted',
        rowId: row.id,
        searchQuery,
        value: empty
          ? null
          : normalizeSortedCursorValue(row.sortValue, valueType),
        viewId: activeView.id,
      } satisfies SortedGridCursor)
    ).toString('base64url');
  }
  return Buffer.from(
    JSON.stringify({
      id: row.id,
      kind: 'position',
      position: row.position,
      searchQuery,
    } satisfies PositionGridCursor)
  ).toString('base64url');
}

function normalizeSortedCursorValue(
  value: unknown,
  valueType: Exclude<SqliteGridColumnValueType, 'empty' | 'json'>
): boolean | string {
  switch (valueType) {
    case 'text':
      if (typeof value === 'string') return value;
      break;
    case 'number':
      if (typeof value === 'number' || typeof value === 'string') {
        return String(value);
      }
      break;
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 0 || value === 1) return value === 1;
      break;
    case 'timestamp': {
      if (value instanceof Date) return value.toISOString();
      const timestamp =
        typeof value === 'number'
          ? value
          : typeof value === 'string' && /^\d+$/.test(value)
            ? Number(value)
            : Number.NaN;
      if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
      break;
    }
  }
  throw new SqliteGridValidationError('The sort cursor could not be created.');
}

function decodeGridCursor(cursor: string): SqliteGridCursor {
  if (cursor.length > 1_024) {
    throw new SqliteGridValidationError('The cursor is invalid.');
  }
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as unknown;
    if (!value || typeof value !== 'object') {
      throw new Error('Invalid cursor shape.');
    }
    const candidate = value as Record<string, unknown>;
    const searchQuery =
      candidate.searchQuery === undefined ? null : candidate.searchQuery;
    if (
      searchQuery !== null &&
      (typeof searchQuery !== 'string' || searchQuery.length > 120)
    ) {
      throw new Error('Invalid cursor search.');
    }
    if (candidate.kind === 'sorted') {
      if (
        !isUuid(candidate.columnId) ||
        !isUuid(candidate.rowId) ||
        !isUuid(candidate.viewId) ||
        (candidate.direction !== 'asc' && candidate.direction !== 'desc') ||
        typeof candidate.empty !== 'boolean' ||
        !(
          candidate.value === null ||
          typeof candidate.value === 'boolean' ||
          (typeof candidate.value === 'string' &&
            candidate.value.length <= 4_096)
        )
      ) {
        throw new Error('Invalid sorted cursor shape.');
      }
      return { ...candidate, searchQuery } as unknown as SortedGridCursor;
    }
    if (
      !isUuid(candidate.id) ||
      typeof candidate.position !== 'string' ||
      candidate.position.length > 512 ||
      (candidate.kind !== undefined && candidate.kind !== 'position')
    ) {
      throw new Error('Invalid position cursor shape.');
    }
    return {
      id: candidate.id,
      kind: 'position',
      position: candidate.position,
      searchQuery,
    };
  } catch (cause) {
    throw new SqliteGridValidationError('The cursor is invalid.', { cause });
  }
}

function parseGridSearchQuery(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = gridSearchQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new SqliteGridValidationError(
      'Search must contain 3 to 120 normalized characters.'
    );
  }
  return parsed.data;
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value
    )
  );
}
