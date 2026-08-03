import { z } from 'zod';
import {
  gridViewFilterSchema,
  gridViewFilterTreeSchema,
  gridViewSortSchema,
} from './grid-view-policy';
import { gridSearchQuerySchema } from './grid-search-policy';
import type { WorkspaceRole } from './workspace-policy';

export const MAXIMUM_CELL_RUN_ATTEMPTS = 5;

export const bulkRunModeSchema = z.enum(['pending', 'all']);
export type BulkRunMode = z.infer<typeof bulkRunModeSchema>;

const allRowsSelectionSnapshotSchema = z.strictObject({
  kind: z.literal('all_rows'),
  searchQuery: gridSearchQuerySchema.nullable().default(null),
});

const savedViewSelectionSnapshotFields = {
  kind: z.literal('saved_view'),
  name: z.string().min(1).max(80),
  searchQuery: gridSearchQuerySchema.nullable().default(null),
  sort: gridViewSortSchema.nullable(),
  updatedAt: z.iso.datetime(),
  viewId: z.string().uuid(),
};

const canonicalSavedViewSelectionSnapshotSchema = z.strictObject({
  filterTree: gridViewFilterTreeSchema,
  ...savedViewSelectionSnapshotFields,
});

const legacySavedViewSelectionSnapshotSchema = z
  .strictObject({
    filters: z.array(gridViewFilterSchema).max(5),
    ...savedViewSelectionSnapshotFields,
  })
  .transform(({ filters, ...snapshot }) => ({
    ...snapshot,
    filterTree: { children: filters, combinator: 'and' as const },
  }));

export const bulkRunSelectionSnapshotSchema = z.union([
  allRowsSelectionSnapshotSchema,
  canonicalSavedViewSelectionSnapshotSchema,
  legacySavedViewSelectionSnapshotSchema,
]);
export type BulkRunSelectionSnapshot = z.infer<
  typeof bulkRunSelectionSnapshotSchema
>;

export const bulkRunInputSchema = z.strictObject({
  batchId: z.string().uuid(),
  workspaceId: z.string().uuid(),
});
export type BulkRunInput = z.infer<typeof bulkRunInputSchema>;

export type BulkRunCellStatus =
  | 'cancelled'
  | 'failed'
  | 'idle'
  | 'queued'
  | 'running'
  | 'stale'
  | 'succeeded'
  | null;

export function canCancelBulkRun(input: {
  actorRole: WorkspaceRole;
  actorUserId: string;
  createdByUserId: string | null;
}): boolean {
  return (
    input.actorRole === 'owner' ||
    input.actorRole === 'admin' ||
    input.actorUserId === input.createdByUserId
  );
}

export function excludedBulkRunStatuses(
  mode: BulkRunMode
): Exclude<BulkRunCellStatus, null>[] {
  return mode === 'all'
    ? ['queued', 'running']
    : ['queued', 'running', 'succeeded'];
}

/**
 * Defines which eligible cells a bulk run may select. Null means the sparse
 * target cell does not exist yet.
 */
export function shouldSelectCellForBulkRun(
  status: BulkRunCellStatus,
  mode: BulkRunMode
): boolean {
  // TODO(product owner): decide whether a failed or cancelled cell should be
  // included automatically, or require the explicit "all" rerun mode.
  return status === null || !excludedBulkRunStatuses(mode).includes(status);
}
