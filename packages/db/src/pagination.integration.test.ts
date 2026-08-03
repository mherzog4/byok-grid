import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  createGridRow,
  ensurePersonalWorkspace,
  getGridRow,
  getGridSnapshot,
  GridAccessError,
  GridValidationError,
  listWorkspaceTables,
  users,
  workspaces,
  writeGridCell,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('grid cursor pagination', () => {
  it('returns stable disjoint pages and a tenant-scoped row refresh', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `page-owner-${crypto.randomUUID()}@example.test`,
            name: 'Page Owner',
          },
          {
            email: `page-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Page Outsider',
          },
        ])
        .returning({ id: users.id, name: users.name });
      userIds.push(owner!.id, outsider!.id);
      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      const [table] = await listWorkspaceTables(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const initial = await getGridSnapshot(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const company = initial.columns.find(
        (column) => column.name === 'Company'
      )!;

      for (let index = 0; index < 5; index += 1) {
        const row = await createGridRow(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        await writeGridCell(db, {
          columnId: company.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'text', value: `Company ${index + 1}` },
          workspaceId: workspace.id,
        });
      }

      const first = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        { limit: 2 }
      );
      const second = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        { cursor: first.pageInfo.nextCursor, limit: 2 }
      );
      const third = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        { cursor: second.pageInfo.nextCursor, limit: 2 }
      );
      expect(first.rows).toHaveLength(2);
      expect(second.rows).toHaveLength(2);
      expect(third.rows).toHaveLength(1);
      expect(first.pageInfo.hasMore).toBe(true);
      expect(second.pageInfo.hasMore).toBe(true);
      expect(third.pageInfo).toEqual({ hasMore: false, nextCursor: null });
      const allIds = [...first.rows, ...second.rows, ...third.rows].map(
        (row) => row.id
      );
      expect(new Set(allIds).size).toBe(5);
      expect(
        [...first.rows, ...second.rows, ...third.rows].every(
          (row) => row.cells[company.id]?.value.type === 'text'
        )
      ).toBe(true);

      const refreshed = await getGridRow(db, {
        rowId: second.rows[0]!.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(refreshed.cells[company.id]?.value.type).toBe('text');
      await expect(
        getGridRow(db, {
          rowId: refreshed.id,
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridAccessError);
      await expect(
        getGridSnapshot(
          db,
          { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
          { cursor: 'not-a-cursor', limit: 2 }
        )
      ).rejects.toBeInstanceOf(GridValidationError);
    } finally {
      if (workspaceIds.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      }
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }
      await client.end();
    }
  });
});
