import {
  isGridViewFilterGroup,
  type GridViewFilter,
  type GridViewFilterGroup,
} from '@byok-grid/domain';
import { and, or, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import { cells, columns, rows } from './schema';

export type SqliteGridColumnValueType =
  (typeof columns.$inferSelect)['valueType'];
export type SqliteGridSortableValueType = Exclude<
  SqliteGridColumnValueType,
  'empty' | 'json'
>;

export function buildSqliteGridViewFilterPredicate(
  filter: GridViewFilter
): SQL {
  const base = sql`${cells.workspaceId} = ${rows.workspaceId}
    and ${cells.tableId} = ${rows.tableId}
    and ${cells.rowId} = ${rows.id}
    and ${cells.columnId} = ${filter.columnId}`;
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
          and instr(lower(coalesce(${cells.valueText}, '')), lower(${filter.value})) > 0
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
          and ${cells.valueBoolean} = ${filter.value ? 1 : 0}
      )`;
    case 'timestamp_after':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'timestamp'
          and ${cells.valueTimestamp} > ${new Date(filter.value).getTime()}
      )`;
    case 'timestamp_before':
      return sql`exists (
        select 1 from ${cells}
        where ${base}
          and ${cells.valueType} = 'timestamp'
          and ${cells.valueTimestamp} < ${new Date(filter.value).getTime()}
      )`;
    case 'status_is':
      return sql`exists (
        select 1 from ${cells}
        where ${base} and ${cells.status} = ${filter.value}
      )`;
  }
}

export function buildSqliteGridViewFilterTreePredicate(
  group: GridViewFilterGroup
): SQL {
  const predicates = group.children.map((child) =>
    isGridViewFilterGroup(child)
      ? buildSqliteGridViewFilterTreePredicate(child)
      : buildSqliteGridViewFilterPredicate(child)
  );
  if (predicates.length === 0) return sql`true`;
  return (group.combinator === 'and' ? and(...predicates) : or(...predicates))!;
}

export function sqliteGridViewSortExpressions(
  sortCells: {
    id: SQLWrapper;
    valueBoolean: SQLWrapper;
    valueNumber: SQLWrapper;
    valueText: SQLWrapper;
    valueTimestamp: SQLWrapper;
    valueType: SQLWrapper;
  },
  valueType: SqliteGridSortableValueType
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
