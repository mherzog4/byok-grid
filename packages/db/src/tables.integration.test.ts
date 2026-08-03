import type { CellValue, EditableInputValueType } from '@byok-grid/domain';
import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  createGridRow,
  createInputColumn,
  createWorkspaceTable,
  ensurePersonalWorkspace,
  getGridSnapshot,
  GridAccessError,
  GridConflictError,
  listWorkspaceTables,
  renameWorkspaceTable,
  writeGridCell,
} from './index';
import { users, workspaceMembers, workspaces } from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('workspace table management', () => {
  it('creates usable tables, adds columns, renames, and scopes mutations', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, member, outsider] = await db
        .insert(users)
        .values([
          {
            email: `tables-owner-${crypto.randomUUID()}@example.test`,
            name: 'Tables Owner',
          },
          {
            email: `tables-member-${crypto.randomUUID()}@example.test`,
            name: 'Tables Member',
          },
          {
            email: `tables-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Tables Outsider',
          },
        ])
        .returning({ id: users.id, name: users.name });
      expect(owner).toBeDefined();
      expect(member).toBeDefined();
      expect(outsider).toBeDefined();
      userIds.push(owner!.id, member!.id, outsider!.id);

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      await db.insert(workspaceMembers).values({
        role: 'member',
        userId: member!.id,
        workspaceId: workspace.id,
      });

      const prospects = await createWorkspaceTable(db, {
        firstColumnName: 'Contact',
        firstColumnValueType: 'text',
        name: ' Prospects ',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(prospects).toMatchObject({
        firstColumn: {
          kind: 'input',
          name: 'Contact',
          valueType: 'text',
        },
        name: 'Prospects',
      });

      const metrics = await createWorkspaceTable(db, {
        firstColumnName: 'Score',
        firstColumnValueType: 'number',
        name: 'Metrics',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(metrics.firstColumn).toMatchObject({
        kind: 'input',
        name: 'Score',
        valueType: 'number',
      });

      await expect(
        createWorkspaceTable(db, {
          firstColumnName: 'Name',
          firstColumnValueType: 'text',
          name: 'prospects',
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridConflictError);

      const emailColumn = await createInputColumn(db, {
        name: 'Email',
        tableId: prospects.id,
        userId: member!.id,
        valueType: 'text',
        workspaceId: workspace.id,
      });
      expect(emailColumn).toMatchObject({
        kind: 'input',
        name: 'Email',
        valueType: 'text',
      });
      await expect(
        createInputColumn(db, {
          name: 'email',
          tableId: prospects.id,
          userId: owner!.id,
          valueType: 'json',
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridConflictError);

      const typedColumns: Array<{
        name: string;
        value: CellValue;
        valueType: EditableInputValueType;
      }> = [
        {
          name: 'Score',
          value: { type: 'number', value: 9.5 },
          valueType: 'number',
        },
        {
          name: 'Active',
          value: { type: 'boolean', value: true },
          valueType: 'boolean',
        },
        {
          name: 'Contacted at',
          value: { type: 'timestamp', value: '2026-07-31T12:30:00.000Z' },
          valueType: 'timestamp',
        },
        {
          name: 'Metadata',
          value: { type: 'json', value: { source: 'browser' } },
          valueType: 'json',
        },
      ];
      for (const definition of typedColumns) {
        await createInputColumn(db, {
          name: definition.name,
          tableId: prospects.id,
          userId: owner!.id,
          valueType: definition.valueType,
          workspaceId: workspace.id,
        });
      }

      const renamed = await renameWorkspaceTable(db, {
        name: 'Qualified prospects',
        tableId: prospects.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(renamed.name).toBe('Qualified prospects');

      const memberTable = await createWorkspaceTable(db, {
        firstColumnName: 'Account',
        firstColumnValueType: 'text',
        name: 'Accounts',
        userId: member!.id,
        workspaceId: workspace.id,
      });
      expect(memberTable.name).toBe('Accounts');

      await expect(
        renameWorkspaceTable(db, {
          name: 'Not accessible',
          tableId: prospects.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridAccessError);

      const snapshot = await getGridSnapshot(db, {
        tableId: prospects.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(snapshot.table.name).toBe('Qualified prospects');
      expect(snapshot.columns.map((column) => column.name)).toEqual([
        'Contact',
        'Email',
        'Score',
        'Active',
        'Contacted at',
        'Metadata',
      ]);
      expect(snapshot.columns.map((column) => column.valueType)).toEqual([
        'text',
        'text',
        'number',
        'boolean',
        'timestamp',
        'json',
      ]);

      const row = await createGridRow(db, {
        tableId: prospects.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      for (const definition of typedColumns) {
        const column = snapshot.columns.find(
          (candidate) => candidate.name === definition.name
        )!;
        await writeGridCell(db, {
          columnId: column.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: prospects.id,
          userId: owner!.id,
          value: definition.value,
          workspaceId: workspace.id,
        });
      }
      const typedSnapshot = await getGridSnapshot(db, {
        tableId: prospects.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      for (const definition of typedColumns) {
        const column = typedSnapshot.columns.find(
          (candidate) => candidate.name === definition.name
        )!;
        expect(typedSnapshot.rows[0]!.cells[column.id]!.value).toEqual(
          definition.value
        );
      }
      expect(
        (
          await listWorkspaceTables(db, {
            userId: owner!.id,
            workspaceId: workspace.id,
          })
        ).map((table) => table.name)
      ).toEqual(['Companies', 'Qualified prospects', 'Metrics', 'Accounts']);
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
