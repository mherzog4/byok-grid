import { describe, expect, it } from 'vitest';
import {
  bulkRunSelectionSnapshotSchema,
  canCancelBulkRun,
  shouldSelectCellForBulkRun,
} from './bulk-run-policy';

describe('bulk run selection policy', () => {
  it('lets creators and managers cancel without granting peer-member control', () => {
    const creator = 'creator-user-id';
    const peer = 'peer-user-id';

    expect(
      canCancelBulkRun({
        actorRole: 'member',
        actorUserId: creator,
        createdByUserId: creator,
      })
    ).toBe(true);
    expect(
      canCancelBulkRun({
        actorRole: 'member',
        actorUserId: peer,
        createdByUserId: creator,
      })
    ).toBe(false);
    expect(
      canCancelBulkRun({
        actorRole: 'admin',
        actorUserId: peer,
        createdByUserId: creator,
      })
    ).toBe(true);
    expect(
      canCancelBulkRun({
        actorRole: 'owner',
        actorUserId: peer,
        createdByUserId: null,
      })
    ).toBe(true);
  });

  it('never duplicates active work', () => {
    expect(shouldSelectCellForBulkRun('queued', 'all')).toBe(false);
    expect(shouldSelectCellForBulkRun('running', 'all')).toBe(false);
  });

  it('selects sparse and retryable cells in pending mode', () => {
    expect(shouldSelectCellForBulkRun(null, 'pending')).toBe(true);
    expect(shouldSelectCellForBulkRun('failed', 'pending')).toBe(true);
    expect(shouldSelectCellForBulkRun('stale', 'pending')).toBe(true);
    expect(shouldSelectCellForBulkRun('succeeded', 'pending')).toBe(false);
  });

  it('allows an explicit rerun of completed cells', () => {
    expect(shouldSelectCellForBulkRun('succeeded', 'all')).toBe(true);
  });

  it('retains a strict immutable saved-view selection snapshot', () => {
    const snapshot = bulkRunSelectionSnapshotSchema.parse({
      filters: [
        {
          columnId: '10000000-0000-4000-8000-000000000001',
          operator: 'text_contains',
          value: 'qualified',
        },
      ],
      kind: 'saved_view',
      name: 'Qualified accounts',
      sort: {
        columnId: '10000000-0000-4000-8000-000000000002',
        direction: 'desc',
      },
      updatedAt: '2026-08-01T00:00:00.000Z',
      viewId: '10000000-0000-4000-8000-000000000003',
    });
    expect(snapshot.kind).toBe('saved_view');
    expect(
      bulkRunSelectionSnapshotSchema.safeParse({ ...snapshot, sql: 'unsafe' })
        .success
    ).toBe(false);
  });
});
