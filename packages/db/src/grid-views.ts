import {
  MAXIMUM_SAVED_GRID_VIEWS_PER_TABLE,
  gridViewFilterLeaves,
  gridViewFilterAcceptsValueType,
  normalizeGridViewFilterTree,
  savedGridViewRequestSchema,
  type GridViewFilterGroup,
  type GridViewSort,
  type SavedGridViewRequest,
  type SavedGridViewRequestInput,
} from '@byok-grid/domain';
import { and, asc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { Database } from './client';
import {
  GridAccessError,
  GridConflictError,
  GridValidationError,
} from './grid';
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

export interface SavedGridViewSummary {
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

export async function listSavedGridViews(
  db: Database,
  scope: GridViewScope
): Promise<SavedGridViewSummary[]> {
  await requireActiveTableMembership(db, scope);
  const views = await db
    .select()
    .from(savedGridViews)
    .where(
      and(
        eq(savedGridViews.workspaceId, scope.workspaceId),
        eq(savedGridViews.tableId, scope.tableId)
      )
    )
    .orderBy(asc(savedGridViews.createdAt), asc(savedGridViews.id));
  return views.map(toSavedGridViewSummary);
}

export async function getSavedGridView(
  db: Database,
  scope: GridViewScope & { viewId: string }
): Promise<SavedGridViewSummary> {
  await requireActiveTableMembership(db, scope);
  const [view] = await db
    .select()
    .from(savedGridViews)
    .where(
      and(
        eq(savedGridViews.id, scope.viewId),
        eq(savedGridViews.workspaceId, scope.workspaceId),
        eq(savedGridViews.tableId, scope.tableId)
      )
    )
    .limit(1);
  if (!view) throw new GridAccessError('The saved view is not accessible.');
  const summary = toSavedGridViewSummary(view);
  await validateViewColumns(db, scope, summary);
  return summary;
}

export async function createSavedGridView(
  db: Database,
  input: GridViewScope & SavedGridViewRequestInput
): Promise<SavedGridViewSummary> {
  const request = parseViewRequest(input);
  return db.transaction(async (tx) => {
    await lockViewNamespace(tx as unknown as Database, input);
    await requireActiveTableMembership(tx as unknown as Database, input);
    await validateViewColumns(tx as unknown as Database, input, request);

    const [viewCount, duplicate] = await Promise.all([
      tx
        .select({ value: sql<number>`count(*)::int` })
        .from(savedGridViews)
        .where(
          and(
            eq(savedGridViews.workspaceId, input.workspaceId),
            eq(savedGridViews.tableId, input.tableId)
          )
        )
        .then(([record]) => record?.value ?? 0),
      findDuplicateName(tx as unknown as Database, input, request.name),
    ]);
    if (viewCount >= MAXIMUM_SAVED_GRID_VIEWS_PER_TABLE) {
      throw new GridValidationError(
        `A table can contain at most ${MAXIMUM_SAVED_GRID_VIEWS_PER_TABLE} saved views.`
      );
    }
    if (duplicate) {
      throw new GridConflictError(
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
    return toSavedGridViewSummary(created);
  });
}

export async function updateSavedGridView(
  db: Database,
  input: GridViewScope & SavedGridViewRequestInput & { viewId: string }
): Promise<SavedGridViewSummary> {
  const request = parseViewRequest(input);
  return db.transaction(async (tx) => {
    await lockViewNamespace(tx as unknown as Database, input);
    await requireActiveTableMembership(tx as unknown as Database, input);
    await validateViewColumns(tx as unknown as Database, input, request);
    const duplicate = await findDuplicateName(
      tx as unknown as Database,
      input,
      request.name,
      input.viewId
    );
    if (duplicate) {
      throw new GridConflictError(
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
    if (!updated)
      throw new GridAccessError('The saved view is not accessible.');
    return toSavedGridViewSummary(updated);
  });
}

export async function deleteSavedGridView(
  db: Database,
  input: GridViewScope & { viewId: string }
): Promise<{ id: string }> {
  return db.transaction(async (tx) => {
    await lockViewNamespace(tx as unknown as Database, input);
    await requireActiveTableMembership(tx as unknown as Database, input);
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
    if (!deleted)
      throw new GridAccessError('The saved view is not accessible.');
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
  db: Database,
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
  db: Database,
  scope: GridViewScope,
  view: {
    filterTree: GridViewFilterGroup;
    sort: GridViewSort | null;
  }
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
    throw new GridValidationError(
      'Every saved-view column must be active in this table.'
    );
  }

  const typeByColumn = new Map(
    activeColumns.map((column) => [column.id, column.valueType])
  );
  for (const filter of gridViewFilterLeaves(view.filterTree)) {
    const valueType = typeByColumn.get(filter.columnId)!;
    if (!gridViewFilterAcceptsValueType(filter, valueType)) {
      throw new GridValidationError(
        `The ${filter.operator} operator cannot filter a ${valueType} column.`
      );
    }
  }
  if (view.sort && typeByColumn.get(view.sort.columnId) === 'json') {
    throw new GridValidationError('JSON columns cannot be sorted.');
  }
}

function toSavedGridViewSummary(
  view: typeof savedGridViews.$inferSelect
): SavedGridViewSummary {
  const { filters, ...summary } = view;
  return {
    ...summary,
    filterTree: normalizeGridViewFilterTree(filters),
  };
}

async function requireActiveTableMembership(
  db: Database,
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
  if (!table) throw new GridAccessError('The table is not accessible.');
}

async function lockViewNamespace(
  db: Database,
  scope: Pick<GridViewScope, 'tableId' | 'workspaceId'>
): Promise<void> {
  const namespace = `saved-grid-views:${scope.workspaceId}:${scope.tableId}`;
  await db.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${namespace}, 0))`
  );
}
