import { z } from 'zod';

export const MINIMUM_GRID_SEARCH_CHARACTERS = 3;
export const MAXIMUM_GRID_SEARCH_CHARACTERS = 120;
export const MAXIMUM_SEARCHABLE_CELL_CHARACTERS = 8_192;

export const gridSearchQuerySchema = z
  .string()
  .transform((value) => value.normalize('NFKC').trim().replaceAll(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(MINIMUM_GRID_SEARCH_CHARACTERS)
      .max(MAXIMUM_GRID_SEARCH_CHARACTERS)
  );

export type GridSearchQuery = z.infer<typeof gridSearchQuerySchema>;
