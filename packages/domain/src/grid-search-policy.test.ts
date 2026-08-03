import { describe, expect, it } from 'vitest';
import {
  gridSearchQuerySchema,
  MAXIMUM_GRID_SEARCH_CHARACTERS,
} from './grid-search-policy';

describe('grid search policy', () => {
  it('normalizes compatibility characters and whitespace once', () => {
    expect(gridSearchQuerySchema.parse('  ＡＣＭＥ\n  Corp  ')).toBe(
      'ACME Corp'
    );
  });

  it('rejects unselective and oversized searches', () => {
    expect(gridSearchQuerySchema.safeParse('ab').success).toBe(false);
    expect(
      gridSearchQuerySchema.safeParse(
        'x'.repeat(MAXIMUM_GRID_SEARCH_CHARACTERS + 1)
      ).success
    ).toBe(false);
  });
});
