'use client';

import type { GridSnapshot } from '@byok-grid/db';
import {
  MAXIMUM_GRID_VIEW_FILTER_DEPTH,
  MAXIMUM_GRID_VIEW_FILTERS,
  MAXIMUM_GRID_VIEW_GROUP_CHILDREN,
  type GridViewFilter,
  type GridViewFilterGroup,
} from '@byok-grid/domain';

type GridColumn = GridSnapshot['columns'][number];
type FilterOperator = GridViewFilter['operator'];

interface FilterDraft {
  columnId: string;
  id: string;
  kind: 'filter';
  operator: FilterOperator;
  value: string;
}

export interface FilterGroupDraft {
  children: Array<FilterDraft | FilterGroupDraft>;
  combinator: 'and' | 'or';
  id: string;
  kind: 'group';
}

export function FilterTreeEditor({
  columns,
  emptyMessage = 'No filters. Every row will match.',
  onChange,
  value,
}: {
  columns: GridSnapshot['columns'];
  emptyMessage?: string;
  onChange: (group: FilterGroupDraft) => void;
  value: FilterGroupDraft;
}) {
  return (
    <FilterGroupEditor
      columns={columns}
      depth={1}
      emptyMessage={emptyMessage}
      group={value}
      onChange={onChange}
      predicateCount={countFilterDrafts(value)}
      root
    />
  );
}

function FilterGroupEditor({
  columns,
  depth,
  emptyMessage,
  group,
  onChange,
  predicateCount,
  root = false,
}: {
  columns: GridSnapshot['columns'];
  depth: number;
  emptyMessage: string;
  group: FilterGroupDraft;
  onChange: (group: FilterGroupDraft) => void;
  predicateCount: number;
  root?: boolean;
}) {
  const replaceChild = (index: number, child: FilterDraft | FilterGroupDraft) =>
    onChange({
      ...group,
      children: group.children.map((current, childIndex) =>
        childIndex === index ? child : current
      ),
    });
  const removeChild = (index: number) =>
    onChange({
      ...group,
      children: group.children.filter(
        (_current, childIndex) => childIndex !== index
      ),
    });
  const groupIsFull = group.children.length >= MAXIMUM_GRID_VIEW_GROUP_CHILDREN;
  const filterLimitReached = predicateCount >= MAXIMUM_GRID_VIEW_FILTERS;

  return (
    <fieldset
      className={root ? 'saved-view-filter-root' : 'saved-view-filter-group'}
    >
      <legend>{root ? 'Filter rules' : `Group level ${depth}`}</legend>
      <div className="saved-view-group-heading">
        <label>
          <span>Rows must match</span>
          <select
            aria-label={`Group level ${depth} operator`}
            onChange={(event) =>
              onChange({
                ...group,
                combinator: event.currentTarget.value as 'and' | 'or',
              })
            }
            value={group.combinator}
          >
            <option value="and">All rules (AND)</option>
            <option value="or">Any rule (OR)</option>
          </select>
        </label>
        <span>
          {predicateCount}/{MAXIMUM_GRID_VIEW_FILTERS} filters
        </span>
      </div>
      <div className="saved-view-filters">
        {group.children.length === 0 ? <p>{emptyMessage}</p> : null}
        {group.children.map((child, index) => {
          if (child.kind === 'group') {
            return (
              <div className="saved-view-nested-group" key={child.id}>
                <FilterGroupEditor
                  columns={columns}
                  depth={depth + 1}
                  emptyMessage={emptyMessage}
                  group={child}
                  onChange={(nextGroup) => replaceChild(index, nextGroup)}
                  predicateCount={predicateCount}
                />
                <button
                  aria-label={`Remove group ${index + 1}`}
                  onClick={() => removeChild(index)}
                  type="button"
                >
                  Remove group
                </button>
              </div>
            );
          }
          const column =
            columns.find((item) => item.id === child.columnId) ?? columns[0];
          if (!column) return null;
          return (
            <div className="saved-view-filter" key={child.id}>
              <label>
                <span>Column</span>
                <select
                  aria-label={`Filter ${index + 1} column`}
                  onChange={(event) => {
                    const nextColumn = columns.find(
                      (item) => item.id === event.currentTarget.value
                    );
                    if (nextColumn)
                      replaceChild(index, {
                        ...defaultFilter(nextColumn),
                        id: child.id,
                      });
                  }}
                  value={child.columnId}
                >
                  {columns.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Condition</span>
                <select
                  aria-label={`Filter ${index + 1} condition`}
                  onChange={(event) => {
                    const operator = event.currentTarget
                      .value as FilterOperator;
                    replaceChild(index, {
                      ...child,
                      operator,
                      value: defaultValueForOperator(operator),
                    });
                  }}
                  value={child.operator}
                >
                  {operatorsForColumn(column).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <FilterValueInput
                filter={child}
                index={index}
                onChange={(value) => replaceChild(index, { ...child, value })}
              />
              <button
                aria-label={`Remove filter ${index + 1}`}
                disabled={!root && group.children.length === 1}
                onClick={() => removeChild(index)}
                type="button"
              >
                Remove
              </button>
            </div>
          );
        })}
      </div>
      <div className="saved-view-group-actions">
        <button
          disabled={columns.length === 0 || filterLimitReached || groupIsFull}
          onClick={() => {
            if (columns[0])
              onChange({
                ...group,
                children: [...group.children, defaultFilter(columns[0])],
              });
          }}
          type="button"
        >
          Add filter
        </button>
        <button
          disabled={
            columns.length === 0 ||
            filterLimitReached ||
            groupIsFull ||
            depth >= MAXIMUM_GRID_VIEW_FILTER_DEPTH
          }
          onClick={() => {
            if (columns[0])
              onChange({
                ...group,
                children: [
                  ...group.children,
                  createFilterGroupDraft(columns[0]),
                ],
              });
          }}
          type="button"
        >
          Add group
        </button>
      </div>
    </fieldset>
  );
}

/**
 * CONTRIBUTOR DECISION POINT: these defaults shape both saved views and
 * automatic-action conditions. Product owners can favor qualification-style
 * comparisons, equality, or completeness checks here.
 */
function defaultFilter(column: GridColumn): FilterDraft {
  const operator: FilterOperator =
    column.valueType === 'text'
      ? 'text_contains'
      : column.valueType === 'number'
        ? 'number_gt'
        : column.valueType === 'boolean'
          ? 'boolean_is'
          : column.valueType === 'timestamp'
            ? 'timestamp_after'
            : 'is_not_empty';
  return {
    columnId: column.id,
    id: crypto.randomUUID(),
    kind: 'filter',
    operator,
    value: defaultValueForOperator(operator),
  };
}

function defaultValueForOperator(operator: FilterOperator): string {
  if (operator === 'boolean_is') return 'true';
  if (operator === 'status_is') return 'failed';
  return '';
}

export function createFilterGroupDraft(
  initialColumn?: GridColumn
): FilterGroupDraft {
  return {
    children: initialColumn ? [defaultFilter(initialColumn)] : [],
    combinator: 'and',
    id: crypto.randomUUID(),
    kind: 'group',
  };
}

export function filterTreeValueToDraft(
  group: GridViewFilterGroup
): FilterGroupDraft {
  return {
    children: group.children.map((child) =>
      'combinator' in child
        ? filterTreeValueToDraft(child)
        : toFilterDraft(child)
    ),
    combinator: group.combinator,
    id: crypto.randomUUID(),
    kind: 'group',
  };
}

export function filterTreeDraftToValue(
  group: FilterGroupDraft
): GridViewFilterGroup {
  return {
    children: group.children.map((child) =>
      child.kind === 'group'
        ? filterTreeDraftToValue(child)
        : toGridViewFilter(child)
    ),
    combinator: group.combinator,
  };
}

function countFilterDrafts(group: FilterGroupDraft): number {
  return group.children.reduce(
    (total, child) =>
      total + (child.kind === 'group' ? countFilterDrafts(child) : 1),
    0
  );
}

function toFilterDraft(filter: GridViewFilter): FilterDraft {
  return {
    columnId: filter.columnId,
    id: crypto.randomUUID(),
    kind: 'filter',
    operator: filter.operator,
    value:
      'value' in filter
        ? filter.operator.startsWith('timestamp_')
          ? String(filter.value).slice(0, 16)
          : String(filter.value)
        : '',
  };
}

function toGridViewFilter(filter: FilterDraft): GridViewFilter {
  switch (filter.operator) {
    case 'is_empty':
    case 'is_not_empty':
      return { columnId: filter.columnId, operator: filter.operator };
    case 'text_contains':
    case 'text_equals':
      return {
        columnId: filter.columnId,
        operator: filter.operator,
        value: filter.value,
      };
    case 'number_equals':
    case 'number_gt':
    case 'number_lt': {
      const value = Number(filter.value);
      if (!Number.isFinite(value))
        throw new TypeError('Enter a finite number.');
      return { columnId: filter.columnId, operator: filter.operator, value };
    }
    case 'boolean_is':
      return {
        columnId: filter.columnId,
        operator: filter.operator,
        value: filter.value === 'true',
      };
    case 'timestamp_after':
    case 'timestamp_before': {
      const value = new Date(filter.value);
      if (Number.isNaN(value.getTime()))
        throw new TypeError('Enter a valid date and time.');
      return {
        columnId: filter.columnId,
        operator: filter.operator,
        value: value.toISOString(),
      };
    }
    case 'status_is':
      return {
        columnId: filter.columnId,
        operator: filter.operator,
        value: filter.value as Extract<
          GridViewFilter,
          { operator: 'status_is' }
        >['value'],
      };
  }
}

function operatorsForColumn(
  column: GridColumn
): Array<{ label: string; value: FilterOperator }> {
  const common: Array<{ label: string; value: FilterOperator }> = [
    { label: 'is empty', value: 'is_empty' },
    { label: 'is not empty', value: 'is_not_empty' },
  ];
  const typed =
    column.valueType === 'text'
      ? [
          { label: 'contains', value: 'text_contains' as const },
          { label: 'equals', value: 'text_equals' as const },
        ]
      : column.valueType === 'number'
        ? [
            { label: 'equals', value: 'number_equals' as const },
            { label: 'is greater than', value: 'number_gt' as const },
            { label: 'is less than', value: 'number_lt' as const },
          ]
        : column.valueType === 'boolean'
          ? [{ label: 'is', value: 'boolean_is' as const }]
          : column.valueType === 'timestamp'
            ? [
                { label: 'is after', value: 'timestamp_after' as const },
                { label: 'is before', value: 'timestamp_before' as const },
              ]
            : [];
  return [...typed, ...common, { label: 'run status is', value: 'status_is' }];
}

function FilterValueInput({
  filter,
  index,
  onChange,
}: {
  filter: FilterDraft;
  index: number;
  onChange: (value: string) => void;
}) {
  if (filter.operator === 'is_empty' || filter.operator === 'is_not_empty') {
    return <span className="saved-view-no-value">No value needed</span>;
  }
  if (filter.operator === 'boolean_is') {
    return (
      <label>
        <span>Value</span>
        <select
          aria-label={`Filter ${index + 1} value`}
          onChange={(event) => onChange(event.currentTarget.value)}
          value={filter.value || 'true'}
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      </label>
    );
  }
  if (filter.operator === 'status_is') {
    return (
      <label>
        <span>Value</span>
        <select
          aria-label={`Filter ${index + 1} value`}
          onChange={(event) => onChange(event.currentTarget.value)}
          value={filter.value || 'failed'}
        >
          {[
            'idle',
            'queued',
            'running',
            'succeeded',
            'failed',
            'stale',
            'cancelled',
          ].map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
    );
  }
  return (
    <label>
      <span>Value</span>
      <input
        aria-label={`Filter ${index + 1} value`}
        maxLength={4_096}
        onChange={(event) => onChange(event.currentTarget.value)}
        required
        step={filter.operator.startsWith('number_') ? 'any' : undefined}
        type={
          filter.operator.startsWith('number_')
            ? 'number'
            : filter.operator.startsWith('timestamp_')
              ? 'datetime-local'
              : 'text'
        }
        value={filter.value}
      />
    </label>
  );
}
