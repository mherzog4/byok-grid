import { z } from 'zod';
import type { CellValueType } from './cell-values';

export const MAXIMUM_SAVED_GRID_VIEWS_PER_TABLE = 50;
export const MAXIMUM_GRID_VIEW_FILTERS = 12;
export const MAXIMUM_GRID_VIEW_FILTER_DEPTH = 3;
export const MAXIMUM_GRID_VIEW_GROUP_CHILDREN = 8;

const gridViewNameSchema = z
  .string()
  .transform((value) => value.trim().normalize('NFKC'))
  .pipe(
    z
      .string()
      .min(1)
      .max(80)
      .refine(
        (value) => !/[\u0000-\u001f\u007f]/u.test(value),
        'View names cannot contain control characters.'
      )
  );

const columnIdSchema = z.string().uuid();

const emptyFilterSchema = z.strictObject({
  columnId: columnIdSchema,
  operator: z.enum(['is_empty', 'is_not_empty']),
});

const textFilterSchema = z.strictObject({
  columnId: columnIdSchema,
  operator: z.enum(['text_contains', 'text_equals']),
  value: z.string().max(4_096),
});

const numberFilterSchema = z.strictObject({
  columnId: columnIdSchema,
  operator: z.enum(['number_equals', 'number_gt', 'number_lt']),
  value: z.number().finite(),
});

const booleanFilterSchema = z.strictObject({
  columnId: columnIdSchema,
  operator: z.literal('boolean_is'),
  value: z.boolean(),
});

const timestampFilterSchema = z.strictObject({
  columnId: columnIdSchema,
  operator: z.enum(['timestamp_after', 'timestamp_before']),
  value: z.iso.datetime(),
});

const statusFilterSchema = z.strictObject({
  columnId: columnIdSchema,
  operator: z.literal('status_is'),
  value: z.enum([
    'idle',
    'queued',
    'running',
    'succeeded',
    'failed',
    'stale',
    'cancelled',
  ]),
});

export const gridViewFilterSchema = z.discriminatedUnion('operator', [
  emptyFilterSchema,
  textFilterSchema,
  numberFilterSchema,
  booleanFilterSchema,
  timestampFilterSchema,
  statusFilterSchema,
]);

export type GridViewFilter = z.infer<typeof gridViewFilterSchema>;
export type GridViewFilterNode = GridViewFilter | GridViewFilterGroup;
export interface GridViewFilterGroup {
  children: ReadonlyArray<GridViewFilterNode>;
  combinator: 'and' | 'or';
}

const recursiveGridViewFilterGroupSchema: z.ZodType<GridViewFilterGroup> =
  z.lazy(() =>
    z.strictObject({
      children: z
        .array(
          z.union([gridViewFilterSchema, recursiveGridViewFilterGroupSchema])
        )
        .max(MAXIMUM_GRID_VIEW_GROUP_CHILDREN),
      combinator: z.enum(['and', 'or']),
    })
  );

export const gridViewFilterTreeSchema =
  recursiveGridViewFilterGroupSchema.superRefine((tree, context) => {
    let predicateCount = 0;
    const visit = (group: GridViewFilterGroup, depth: number) => {
      if (depth > MAXIMUM_GRID_VIEW_FILTER_DEPTH) {
        context.addIssue({
          code: 'custom',
          message: `Filter groups cannot be deeper than ${MAXIMUM_GRID_VIEW_FILTER_DEPTH} levels.`,
        });
        return;
      }
      if (depth > 1 && group.children.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Nested filter groups cannot be empty.',
        });
      }
      for (const child of group.children) {
        if (isGridViewFilterGroup(child)) visit(child, depth + 1);
        else predicateCount += 1;
      }
    };
    visit(tree, 1);
    if (predicateCount > MAXIMUM_GRID_VIEW_FILTERS) {
      context.addIssue({
        code: 'custom',
        message: `A view can contain at most ${MAXIMUM_GRID_VIEW_FILTERS} filters.`,
      });
    }
  });

const legacyGridViewFiltersSchema = z
  .array(gridViewFilterSchema)
  .max(5)
  .transform((children): GridViewFilterGroup => ({
    combinator: 'and',
    children,
  }));

export const persistedGridViewFilterTreeSchema = z.union([
  gridViewFilterTreeSchema,
  legacyGridViewFiltersSchema,
]);

export const gridViewSortSchema = z.strictObject({
  columnId: columnIdSchema,
  direction: z.enum(['asc', 'desc']),
});

const canonicalSavedGridViewRequestSchema = z.strictObject({
  filterTree: gridViewFilterTreeSchema,
  name: gridViewNameSchema,
  sort: gridViewSortSchema.nullable(),
});

const legacySavedGridViewRequestSchema = z
  .strictObject({
    filters: z.array(gridViewFilterSchema).max(5),
    name: gridViewNameSchema,
    sort: gridViewSortSchema.nullable(),
  })
  .transform(({ filters, ...request }) => ({
    ...request,
    filterTree: { children: filters, combinator: 'and' as const },
  }));

export const savedGridViewRequestSchema = z.union([
  canonicalSavedGridViewRequestSchema,
  legacySavedGridViewRequestSchema,
]);

export type GridViewSort = z.infer<typeof gridViewSortSchema>;
export type SavedGridViewRequest = z.infer<typeof savedGridViewRequestSchema>;
export type SavedGridViewRequestInput = z.input<
  typeof savedGridViewRequestSchema
>;

export function isGridViewFilterGroup(
  node: GridViewFilterNode
): node is GridViewFilterGroup {
  return 'combinator' in node;
}

export function gridViewFilterLeaves(
  group: GridViewFilterGroup
): GridViewFilter[] {
  return group.children.flatMap((child) =>
    isGridViewFilterGroup(child) ? gridViewFilterLeaves(child) : [child]
  );
}

export function normalizeGridViewFilterTree(
  value: unknown
): GridViewFilterGroup {
  return persistedGridViewFilterTreeSchema.parse(value);
}

export function filterOperatorRequiresValue(
  operator: GridViewFilter['operator']
): boolean {
  return operator !== 'is_empty' && operator !== 'is_not_empty';
}

export function gridViewFilterAcceptsValueType(
  filter: GridViewFilter,
  valueType: CellValueType
): boolean {
  const expectedType = filter.operator.split('_')[0];
  return (
    expectedType === 'is' ||
    expectedType === 'status' ||
    expectedType === valueType
  );
}
