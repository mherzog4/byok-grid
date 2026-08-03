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
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from './client';
import { deserializeCellValue, serializeCellValue } from './cell-values';
import { recomputeDependentFormulasForRow } from './formulas';
import {
  buildGridSearchPredicate,
  buildGridViewFilterTreePredicate,
  gridViewSortExpressions,
  type GridColumnValueType,
} from './grid-view-query';
import { getSavedGridView, type SavedGridViewSummary } from './grid-views';
import { recordRowMutationAndMaybeQueueSettlement } from './row-automations';
import { lockTableCellSchemaShared } from './schema-locks';
import { cells, columns, dataTables, rows, workspaceMembers } from './schema';

export class GridAccessError extends Error {}
export class GridConflictError extends Error {}
export class GridValidationError extends Error {}

export interface GridCell {
  id: string;
  status: (typeof cells.$inferSelect)['status'];
  value: CellValue;
  version: number;
}

export interface GridSnapshot {
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
  rows: GridRow[];
  searchQuery: string | null;
  table: { id: string; name: string };
  workspaceId: string;
}

export interface GridRow {
  cells: Record<string, GridCell>;
  id: string;
  position: string;
  version: number;
}

interface GridScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export async function listWorkspaceTables(
  db: Database,
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
    .orderBy(asc(dataTables.createdAt));
}

export async function getGridSnapshot(
  db: Database,
  scope: GridScope,
  options: {
    cursor?: string | null;
    limit?: number;
    searchQuery?: string | null;
    viewId?: string | null;
  } = {}
): Promise<GridSnapshot> {
  const table = await requireTableAccess(db, scope);
  const limit = Math.max(1, Math.min(options.limit ?? 100, 200));
  const searchQuery = parseGridSearchQuery(options.searchQuery);
  const cursor = options.cursor ? decodeGridCursor(options.cursor) : null;
  const activeView = options.viewId
    ? await getSavedGridView(db, { ...scope, viewId: options.viewId })
    : null;
  const gridColumns = await db
    .select({
      id: columns.id,
      configuration: columns.configuration,
      kind: columns.kind,
      name: columns.name,
      position: columns.position,
      valueType: columns.valueType,
    })
    .from(columns)
    .where(
      and(
        eq(columns.workspaceId, scope.workspaceId),
        eq(columns.tableId, scope.tableId),
        isNull(columns.archivedAt)
      )
    )
    .orderBy(asc(columns.position));
  const selectedRows = await selectGridRows(
    db,
    scope,
    activeView,
    cursor,
    limit + 1,
    searchQuery,
    new Map(gridColumns.map((column) => [column.id, column.valueType]))
  );

  const hasMore = selectedRows.length > limit;
  const gridRows = selectedRows.slice(0, limit);
  const rowIds = gridRows.map((row) => row.id);
  const gridCells =
    rowIds.length === 0
      ? []
      : await db
          .select()
          .from(cells)
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
        cells: {} as Record<string, GridCell>,
        id: row.id,
        position: row.position,
        version: row.version,
      },
    ])
  );
  for (const cell of gridCells) {
    const row = rowMap.get(cell.rowId);
    if (row) {
      row.cells[cell.columnId] = {
        id: cell.id,
        status: cell.status,
        value: deserializeCellValue(cell),
        version: cell.version,
      };
    }
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
          ? encodeGridCursor(gridRows.at(-1)!, activeView, searchQuery)
          : null,
    },
    rows: [...rowMap.values()],
    searchQuery,
    table,
    workspaceId: scope.workspaceId,
  };
}

function readConnectorRunMode(
  configuration: Readonly<Record<string, unknown>>
): ConnectorRunMode {
  const parsed = connectorRunModeSchema.safeParse(configuration.runMode);
  return parsed.success ? parsed.data : 'manual';
}

export async function getGridRow(
  db: Database,
  scope: GridScope & { rowId: string }
): Promise<GridRow> {
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
  if (!row) throw new GridAccessError('The row is not accessible.');
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

export async function createGridRow(
  db: Database,
  scope: GridScope
): Promise<{ id: string; position: string; version: number }> {
  await requireTableAccess(db, scope);
  const position = `${Date.now().toString().padStart(13, '0')}-${crypto.randomUUID()}`;
  const [row] = await db
    .insert(rows)
    .values({
      workspaceId: scope.workspaceId,
      tableId: scope.tableId,
      position,
    })
    .returning({ id: rows.id, position: rows.position, version: rows.version });

  if (!row) throw new Error('The row could not be created.');
  return row;
}

export async function writeGridCell(
  db: Database,
  scope: GridScope & {
    columnId: string;
    expectedVersion: number;
    rowId: string;
    value: CellValue;
  }
): Promise<GridCell> {
  const value = editableCellValueSchema.parse(scope.value);

  return db.transaction(async (tx) => {
    await requireTableAccess(tx as unknown as Database, scope);
    await lockTableCellSchemaShared(tx, scope);
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
      .limit(1)
      .for('update', { of: rows });

    if (!target) throw new GridAccessError('The cell is not accessible.');
    if (target.columnKind !== 'input') {
      throw new GridValidationError('Only input columns can be edited.');
    }
    if (value.type !== 'empty' && value.type !== target.columnValueType) {
      throw new GridValidationError(
        `This column requires ${target.columnValueType} values.`
      );
    }

    const [existing] = await tx
      .select({ id: cells.id, version: cells.version })
      .from(cells)
      .where(
        and(eq(cells.rowId, scope.rowId), eq(cells.columnId, scope.columnId))
      )
      .limit(1);
    const serialized = serializeCellValue(value);

    let written: typeof cells.$inferSelect;
    if (!existing) {
      if (scope.expectedVersion !== 0) throw new GridConflictError();
      const [created] = await tx
        .insert(cells)
        .values({
          ...serialized,
          workspaceId: scope.workspaceId,
          tableId: scope.tableId,
          rowId: scope.rowId,
          columnId: scope.columnId,
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
            eq(cells.version, scope.expectedVersion)
          )
        )
        .returning();
      if (!updated) throw new GridConflictError();
      written = updated;
    }

    const changedFormulaIds = await recomputeDependentFormulasForRow(tx, {
      changedColumnIds: [scope.columnId],
      rowId: scope.rowId,
      tableId: scope.tableId,
      workspaceId: scope.workspaceId,
    });
    await recordRowMutationAndMaybeQueueSettlement(tx, {
      ...scope,
      changedColumnIds: [scope.columnId, ...changedFormulaIds],
    });
    return toGridCell(written);
  });
}

async function requireTableAccess(db: Database, scope: GridScope) {
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
  if (!table) throw new GridAccessError('The table is not accessible.');
  return table;
}

function toGridCell(cell: typeof cells.$inferSelect): GridCell {
  return {
    id: cell.id,
    status: cell.status,
    value: deserializeCellValue(cell),
    version: cell.version,
  };
}

interface SelectedGridRow {
  id: string;
  position: string;
  sortEmpty?: boolean;
  sortValue?: unknown;
  version: number;
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

type GridCursor = PositionGridCursor | SortedGridCursor;

async function selectGridRows(
  db: Database,
  scope: GridScope,
  activeView: SavedGridViewSummary | null,
  cursor: GridCursor | null,
  limit: number,
  searchQuery: string | null,
  valueTypes: ReadonlyMap<string, GridColumnValueType>
): Promise<SelectedGridRow[]> {
  const filterPredicate = activeView
    ? buildGridViewFilterTreePredicate(activeView.filterTree)
    : undefined;
  const searchPredicate = buildGridSearchPredicate(searchQuery);
  if (cursor && cursor.searchQuery !== searchQuery) {
    throw new GridValidationError('The cursor does not match this search.');
  }
  if (!activeView?.sort) {
    if (cursor?.kind === 'sorted') {
      throw new GridValidationError('The cursor does not match this view.');
    }
    return db
      .select({ id: rows.id, position: rows.position, version: rows.version })
      .from(rows)
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
    throw new GridValidationError('The saved-view sort column is invalid.');
  }
  if (
    cursor &&
    (cursor.kind !== 'sorted' ||
      cursor.viewId !== activeView.id ||
      cursor.columnId !== sort.columnId ||
      cursor.direction !== sort.direction)
  ) {
    throw new GridValidationError('The cursor does not match this view.');
  }

  const sortCells = alias(cells, 'saved_view_sort_cell');
  const { sortEmpty, sortValue } = gridViewSortExpressions(
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
  valueType: Exclude<GridColumnValueType, 'empty' | 'json'>
): SQL {
  const rowAfter =
    cursor.direction === 'asc'
      ? gt(rows.id, cursor.rowId)
      : lt(rows.id, cursor.rowId);
  if (cursor.empty) {
    return and(sql`${sortEmpty} = true`, rowAfter)!;
  }
  if (cursor.value === null) {
    throw new GridValidationError('The cursor is invalid.');
  }
  const value = parseSortedCursorValue(cursor.value, valueType);
  const valueAfter =
    cursor.direction === 'asc'
      ? sql`${sortValue} > ${value}`
      : sql`${sortValue} < ${value}`;
  return or(
    and(
      sql`${sortEmpty} = false`,
      or(valueAfter, and(sql`${sortValue} = ${value}`, rowAfter))
    ),
    sql`${sortEmpty} = true`
  )!;
}

function parseSortedCursorValue(
  value: boolean | string,
  valueType: Exclude<GridColumnValueType, 'empty' | 'json'>
): boolean | number | string {
  switch (valueType) {
    case 'text':
      if (typeof value !== 'string')
        throw new GridValidationError('The cursor is invalid.');
      return value;
    case 'number': {
      const parsed = typeof value === 'string' ? Number(value) : Number.NaN;
      if (!Number.isFinite(parsed))
        throw new GridValidationError('The cursor is invalid.');
      return parsed;
    }
    case 'boolean':
      if (typeof value !== 'boolean')
        throw new GridValidationError('The cursor is invalid.');
      return value;
    case 'timestamp': {
      const parsed = typeof value === 'string' ? new Date(value) : new Date('');
      if (Number.isNaN(parsed.getTime()))
        throw new GridValidationError('The cursor is invalid.');
      return parsed.toISOString();
    }
  }
}

function encodeGridCursor(
  row: SelectedGridRow,
  activeView: SavedGridViewSummary | null,
  searchQuery: string | null
): string {
  if (activeView?.sort) {
    const empty = row.sortEmpty ?? true;
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
          : normalizeSortedCursorValue(row.sortValue, activeView.sort.columnId),
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
  _columnId: string
): boolean | string {
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number' || typeof value === 'string')
    return String(value);
  throw new GridValidationError('The sort cursor could not be created.');
}

function decodeGridCursor(cursor: string): GridCursor {
  if (cursor.length > 1_024)
    throw new GridValidationError('The cursor is invalid.');
  try {
    const value = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8')
    ) as unknown;
    if (!value || typeof value !== 'object')
      throw new Error('Invalid cursor shape.');
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
  } catch (error) {
    throw new GridValidationError('The cursor is invalid.', { cause: error });
  }
}

function parseGridSearchQuery(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const parsed = gridSearchQuerySchema.safeParse(value);
  if (!parsed.success) {
    throw new GridValidationError(
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
