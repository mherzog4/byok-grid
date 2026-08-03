import { describe, expect, it } from 'vitest';
import {
  gridViewFilterLeaves,
  MAXIMUM_GRID_VIEW_GROUP_CHILDREN,
  MAXIMUM_GRID_VIEW_FILTERS,
  normalizeGridViewFilterTree,
  filterOperatorRequiresValue,
  savedGridViewRequestSchema,
} from './grid-view-policy';

describe('saved grid view policy', () => {
  it('normalizes names and preserves typed filters', () => {
    const parsed = savedGridViewRequestSchema.parse({
      filterTree: {
        children: [
          {
            columnId: '11111111-1111-4111-8111-111111111111',
            operator: 'number_gt',
            value: 42,
          },
        ],
        combinator: 'and',
      },
      name: '  Qualified leads  ',
      sort: {
        columnId: '22222222-2222-4222-8222-222222222222',
        direction: 'desc',
      },
    });

    expect(parsed.name).toBe('Qualified leads');
    expect(gridViewFilterLeaves(parsed.filterTree)[0]).toMatchObject({
      operator: 'number_gt',
      value: 42,
    });
  });

  it('bounds nested filters by total predicates and depth', () => {
    const filters = Array.from(
      { length: MAXIMUM_GRID_VIEW_FILTERS + 1 },
      (_, index) => ({
        columnId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        operator: 'is_not_empty' as const,
      })
    );
    expect(
      savedGridViewRequestSchema.safeParse({
        filterTree: { children: filters, combinator: 'or' },
        name: 'Too broad',
        sort: null,
      }).success
    ).toBe(false);

    const columnId = '11111111-1111-4111-8111-111111111111';
    expect(
      savedGridViewRequestSchema.safeParse({
        filterTree: {
          children: [
            {
              children: [
                {
                  children: [
                    {
                      children: [{ columnId, operator: 'is_empty' }],
                      combinator: 'and',
                    },
                  ],
                  combinator: 'and',
                },
              ],
              combinator: 'and',
            },
          ],
          combinator: 'and',
        },
        name: 'Too deep',
        sort: null,
      }).success
    ).toBe(false);
  });

  it('bounds each group fanout and rejects empty nested groups', () => {
    const filters = Array.from(
      { length: MAXIMUM_GRID_VIEW_GROUP_CHILDREN + 1 },
      (_, index) => ({
        columnId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        operator: 'is_not_empty' as const,
      })
    );
    expect(
      savedGridViewRequestSchema.safeParse({
        filterTree: { children: filters, combinator: 'or' },
        name: 'Too wide',
        sort: null,
      }).success
    ).toBe(false);

    expect(
      savedGridViewRequestSchema.safeParse({
        filterTree: {
          children: [{ children: [], combinator: 'and' }],
          combinator: 'and',
        },
        name: 'Empty nested group',
        sort: null,
      }).success
    ).toBe(false);
  });

  it('upgrades legacy flat filters to a canonical AND group', () => {
    const columnId = '11111111-1111-4111-8111-111111111111';
    expect(
      normalizeGridViewFilterTree([{ columnId, operator: 'is_not_empty' }])
    ).toEqual({
      children: [{ columnId, operator: 'is_not_empty' }],
      combinator: 'and',
    });
  });

  it('identifies operators that need an authored value', () => {
    expect(filterOperatorRequiresValue('is_empty')).toBe(false);
    expect(filterOperatorRequiresValue('text_contains')).toBe(true);
  });
});
