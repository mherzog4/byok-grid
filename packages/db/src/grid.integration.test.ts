import { describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDatabase } from './client';
import {
  createGridRow,
  ensurePersonalWorkspace,
  getGridSnapshot,
  GridAccessError,
  GridConflictError,
  listWorkspaceTables,
  writeGridCell,
} from './index';
import { users, workspaces } from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('editable grid', () => {
  it('persists sparse cells and rejects cross-tenant and stale access', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `grid-owner-${crypto.randomUUID()}@example.test`,
            name: 'Grid Owner',
          },
          {
            email: `grid-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Grid Outsider',
          },
        ])
        .returning({ id: users.id, name: users.name });
      expect(owner).toBeDefined();
      expect(outsider).toBeDefined();
      userIds.push(owner!.id, outsider!.id);

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      const [table] = await listWorkspaceTables(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(table).toBeDefined();

      const emptySnapshot = await getGridSnapshot(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(emptySnapshot.rows).toHaveLength(0);
      expect(emptySnapshot.columns).toHaveLength(2);

      const row = await createGridRow(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const companyColumn = emptySnapshot.columns[0]!;
      const cell = await writeGridCell(db, {
        columnId: companyColumn.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme' },
        workspaceId: workspace.id,
      });
      expect(cell.value).toEqual({ type: 'text', value: 'Acme' });
      expect(cell.version).toBe(1);

      await expect(
        writeGridCell(db, {
          columnId: companyColumn.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'text', value: 'Stale overwrite' },
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridConflictError);

      await expect(
        getGridSnapshot(db, {
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridAccessError);

      const savedSnapshot = await getGridSnapshot(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(savedSnapshot.rows[0]?.cells[companyColumn.id]?.value).toEqual({
        type: 'text',
        value: 'Acme',
      });
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
