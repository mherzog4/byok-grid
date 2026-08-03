import {
  isGridViewFilterGroup,
  type GridViewFilter,
  type GridViewFilterGroup,
} from '@byok-grid/domain';
import { and, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { cells, columns, rows } from './schema';

export type GridColumnValueType = (typeof columns.$inferSelect)['valueType'];
export type GridSortableValueType = Exclude<
  GridColumnValueType,
  'empty' | 'json'
>;

/**
 * Builds only allowlisted SQL fragments. Persisted values always remain bound
 * parameters and never become identifiers or raw authored SQL.
 */
export function buildGridViewFilterPredicate(filter: GridViewFilter): SQL {
  const base = sql`${cells.rowId} = ${rows.id} and ${cells.columnId} = ${filter.columnId}`;
  switch (filter.operator) {
    case 'is_empty':
      return sql`not exists (
        select 1 from ${cells}
        where ${base} and ${cells.valueType} <> 'empty'
      )`;
    case 'is_not_empty':
      return sql`exists (
        select 1 from ${cells}
        where ${base} and ${cells.valueType} <> 'empty'
      )`;
    case 'text_contains':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'text'
          and position(lower(${filter.value}) in lower(${cells.valueText})) > 0
      )`;
    case 'text_equals':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'text'
          and lower(${cells.valueText}) = lower(${filter.value})
      )`;
    case 'number_equals':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'number'
          and ${cells.valueNumber} = ${filter.value}
      )`;
    case 'number_gt':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'number'
          and ${cells.valueNumber} > ${filter.value}
      )`;
    case 'number_lt':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'number'
          and ${cells.valueNumber} < ${filter.value}
      )`;
    case 'boolean_is':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'boolean'
          and ${cells.valueBoolean} = ${filter.value}
      )`;
    case 'timestamp_after':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'timestamp'
          and ${cells.valueTimestamp} > ${filter.value}::timestamptz
      )`;
    case 'timestamp_before':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'timestamp'
          and ${cells.valueTimestamp} < ${filter.value}::timestamptz
      )`;
    case 'status_is':
      return sql`exists (
        select 1 from ${cells}
        where ${base} and ${cells.status} = ${filter.value}
      )`;
  }
}

export function buildGridViewFilterTreePredicate(
  group: GridViewFilterGroup
): SQL {
  const predicates = group.children.map((child) =>
    isGridViewFilterGroup(child)
      ? buildGridViewFilterTreePredicate(child)
      : buildGridViewFilterPredicate(child)
  );
  if (predicates.length === 0) return sql`true`;
  return (group.combinator === 'and' ? and(...predicates) : or(...predicates))!;
}

export function buildGridSearchPredicate(
  searchQuery: string | null
): SQL | undefined {
  if (searchQuery === null) return undefined;
  const escaped = searchQuery
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
  const pattern = `%${escaped}%`;
  return sql`exists (
    select 1 from ${cells}
    where ${cells.workspaceId} = ${rows.workspaceId}
      and ${cells.tableId} = ${rows.tableId}
      and ${cells.rowId} = ${rows.id}
      and ${cells.searchText} <> ''
      and ${cells.searchText} ilike ${pattern} escape ${'\\'}
  )`;
}

export function gridViewSortExpressions(
  sortCells: {
    id: SQLWrapper;
    valueBoolean: SQLWrapper;
    valueNumber: SQLWrapper;
    valueText: SQLWrapper;
    valueTimestamp: SQLWrapper;
    valueType: SQLWrapper;
  },
  valueType: GridSortableValueType
): { sortEmpty: SQL<boolean>; sortValue: SQL<unknown> } {
  const sortValue: SQL<unknown> = (() => {
    switch (valueType) {
      case 'text':
        return sql`${sortCells.valueText}`;
      case 'number':
        return sql`${sortCells.valueNumber}`;
      case 'boolean':
        return sql`${sortCells.valueBoolean}`;
      case 'timestamp':
        return sql`${sortCells.valueTimestamp}`;
    }
  })();
  return {
    sortEmpty: sql<boolean>`(${sortCells.id} is null or ${sortCells.valueType} = 'empty')`,
    sortValue,
  };
}
