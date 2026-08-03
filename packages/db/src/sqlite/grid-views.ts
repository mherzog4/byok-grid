import {
  gridViewFilterAcceptsValueType,
  gridViewFilterLeaves,
  MAXIMUM_SAVED_GRID_VIEWS_PER_TABLE,
  normalizeGridViewFilterTree,
  savedGridViewRequestSchema,
  type GridViewFilterGroup,
  type GridViewSort,
  type SavedGridViewRequest,
  type SavedGridViewRequestInput,
} from '@byok-grid/domain';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import {
  SqliteGridAccessError,
  SqliteGridConflictError,
  SqliteGridValidationError,
} from './grid-errors';
import {
  columns,
  dataTables,
  savedGridViews,
  workspaceMembers,
} from './schema';

interface GridViewScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface SqliteSavedGridViewSummary {
  createdAt: Date;
  createdByUserId: string | null;
  filterTree: GridViewFilterGroup;
  id: string;
  name: string;
  sort: GridViewSort | null;
  tableId: string;
  updatedAt: Date;
  workspaceId: string;
}

export async function listSqliteSavedGridViews(
  db: SqliteDatabase,
  scope: GridViewScope
): Promise<SqliteSavedGridViewSummary[]> {
  await requireActiveTableMembership(db, scope);
  const views = await db
    .select({ view: savedGridViews })
    .from(savedGridViews)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, savedGridViews.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(
      and(
        eq(savedGridViews.workspaceId, scope.workspaceId),
        eq(savedGridViews.tableId, scope.tableId)
      )
    )
    .orderBy(asc(savedGridViews.createdAt), asc(savedGridViews.id));
  return views.map(({ view }) => toSqliteSavedGridViewSummary(view));
}

export async function getSqliteSavedGridView(
  db: SqliteDatabase,
  scope: GridViewScope & { viewId: string }
): Promise<SqliteSavedGridViewSummary> {
  await requireActiveTableMembership(db, scope);
  const [record] = await db
    .select({ view: savedGridViews })
    .from(savedGridViews)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, savedGridViews.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(
      and(
        eq(savedGridViews.id, scope.viewId),
        eq(savedGridViews.workspaceId, scope.workspaceId),
        eq(savedGridViews.tableId, scope.tableId)
      )
    )
    .limit(1);
  if (!record) {
    throw new SqliteGridAccessError('The saved view is not accessible.');
  }
  const summary = toSqliteSavedGridViewSummary(record.view);
  await validateViewColumns(db, scope, summary);
  return summary;
}

export async function createSqliteSavedGridView(
  db: SqliteDatabase,
  input: GridViewScope & SavedGridViewRequestInput
): Promise<SqliteSavedGridViewSummary> {
  const request = parseViewRequest(input);
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireActiveTableMembership(tx, input);
    await validateViewColumns(tx, input, request);

    const [viewCount] = await tx
      .select({ value: sql<number>`count(*)` })
      .from(savedGridViews)
      .where(
        and(
          eq(savedGridViews.workspaceId, input.workspaceId),
          eq(savedGridViews.tableId, input.tableId)
        )
      );
    if ((viewCount?.value ?? 0) >= MAXIMUM_SAVED_GRID_VIEWS_PER_TABLE) {
      throw new SqliteGridValidationError(
        `A table can contain at most ${MAXIMUM_SAVED_GRID_VIEWS_PER_TABLE} saved views.`
      );
    }
    if (await findDuplicateName(tx, input, request.name)) {
      throw new SqliteGridConflictError(
        'A saved view with this name already exists.'
      );
    }

    const [created] = await tx
      .insert(savedGridViews)
      .values({
        createdByUserId: input.userId,
        filters: request.filterTree,
        name: request.name,
        sort: request.sort,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!created) throw new Error('The saved view could not be created.');
    return toSqliteSavedGridViewSummary(created);
  });
}

export async function updateSqliteSavedGridView(
  db: SqliteDatabase,
  input: GridViewScope & SavedGridViewRequestInput & { viewId: string }
): Promise<SqliteSavedGridViewSummary> {
  const request = parseViewRequest(input);
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireActiveTableMembership(tx, input);
    await validateViewColumns(tx, input, request);
    if (await findDuplicateName(tx, input, request.name, input.viewId)) {
      throw new SqliteGridConflictError(
        'A saved view with this name already exists.'
      );
    }

    const [updated] = await tx
      .update(savedGridViews)
      .set({
        filters: request.filterTree,
        name: request.name,
        sort: request.sort,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(savedGridViews.id, input.viewId),
          eq(savedGridViews.workspaceId, input.workspaceId),
          eq(savedGridViews.tableId, input.tableId)
        )
      )
      .returning();
    if (!updated) {
      throw new SqliteGridAccessError('The saved view is not accessible.');
    }
    return toSqliteSavedGridViewSummary(updated);
  });
}

export async function deleteSqliteSavedGridView(
  db: SqliteDatabase,
  input: GridViewScope & { viewId: string }
): Promise<{ id: string }> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireActiveTableMembership(tx, input);
    const [deleted] = await tx
      .delete(savedGridViews)
      .where(
        and(
          eq(savedGridViews.id, input.viewId),
          eq(savedGridViews.workspaceId, input.workspaceId),
          eq(savedGridViews.tableId, input.tableId)
        )
      )
      .returning({ id: savedGridViews.id });
    if (!deleted) {
      throw new SqliteGridAccessError('The saved view is not accessible.');
    }
    return deleted;
  });
}

function parseViewRequest(
  input: SavedGridViewRequestInput
): SavedGridViewRequest {
  return savedGridViewRequestSchema.parse({
    ...('filterTree' in input
      ? { filterTree: input.filterTree }
      : { filters: input.filters }),
    name: input.name,
    sort: input.sort,
  });
}

async function findDuplicateName(
  db: Pick<SqliteDatabase, 'select'>,
  scope: GridViewScope,
  name: string,
  excludedViewId?: string
): Promise<boolean> {
  const [duplicate] = await db
    .select({ id: savedGridViews.id })
    .from(savedGridViews)
    .where(
      and(
        eq(savedGridViews.workspaceId, scope.workspaceId),
        eq(savedGridViews.tableId, scope.tableId),
        sql`lower(${savedGridViews.name}) = lower(${name})`,
        excludedViewId ? ne(savedGridViews.id, excludedViewId) : undefined
      )
    )
    .limit(1);
  return Boolean(duplicate);
}

async function validateViewColumns(
  db: Pick<SqliteDatabase, 'select'>,
  scope: GridViewScope,
  view: { filterTree: GridViewFilterGroup; sort: GridViewSort | null }
): Promise<void> {
  const columnIds = [
    ...new Set([
      ...gridViewFilterLeaves(view.filterTree).map((filter) => filter.columnId),
      ...(view.sort ? [view.sort.columnId] : []),
    ]),
  ];
  if (columnIds.length === 0) return;

  const activeColumns = await db
    .select({ id: columns.id, valueType: columns.valueType })
    .from(columns)
    .where(
      and(
        eq(columns.workspaceId, scope.workspaceId),
        eq(columns.tableId, scope.tableId),
        inArray(columns.id, columnIds),
        isNull(columns.archivedAt)
      )
    );
  if (activeColumns.length !== columnIds.length) {
    throw new SqliteGridValidationError(
      'Every saved-view column must be active in this table.'
    );
  }

  const typeByColumn = new Map(
    activeColumns.map((column) => [column.id, column.valueType])
  );
  for (const filter of gridViewFilterLeaves(view.filterTree)) {
    const valueType = typeByColumn.get(filter.columnId)!;
    if (!gridViewFilterAcceptsValueType(filter, valueType)) {
      throw new SqliteGridValidationError(
        `The ${filter.operator} operator cannot filter a ${valueType} column.`
      );
    }
  }
  if (view.sort && typeByColumn.get(view.sort.columnId) === 'json') {
    throw new SqliteGridValidationError('JSON columns cannot be sorted.');
  }
}

function toSqliteSavedGridViewSummary(
  view: typeof savedGridViews.$inferSelect
): SqliteSavedGridViewSummary {
  const { filters, ...summary } = view;
  return {
    ...summary,
    filterTree: normalizeGridViewFilterTree(filters),
  };
}

async function requireActiveTableMembership(
  db: Pick<SqliteDatabase, 'select'>,
  scope: GridViewScope
): Promise<void> {
  const [table] = await db
    .select({ id: dataTables.id })
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
}
