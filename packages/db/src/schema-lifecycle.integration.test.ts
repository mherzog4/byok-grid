import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase, withAuthenticatedDatabase } from './client';
import {
  archiveWorkspaceColumn,
  archiveWorkspaceTable,
  convertWorkspaceColumnType,
  createFormulaColumn,
  createGridRow,
  createInputColumn,
  createWorkspaceTable,
  ensurePersonalWorkspace,
  getGridSnapshot,
  GridAccessError,
  GridConflictError,
  GridValidationError,
  listArchivedTableColumns,
  listArchivedWorkspaceTables,
  listWorkspaceTables,
  previewColumnArchive,
  previewColumnTypeConversion,
  previewTableArchive,
  restoreWorkspaceColumn,
  restoreWorkspaceTable,
  writeGridCell,
} from './index';
import {
  cells,
  columns,
  schemaLifecycleEvents,
  users,
  workspaceMembers,
  workspaces,
} from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const rlsDatabaseUrl = process.env.RLS_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('recoverable schema lifecycle', () => {
  it('previews and atomically converts every stored input cell', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner] = await db
        .insert(users)
        .values({
          email: `conversion-owner-${crypto.randomUUID()}@example.test`,
          name: 'Conversion Owner',
        })
        .returning({ id: users.id, name: users.name });
      expect(owner).toBeDefined();
      userIds.push(owner!.id);

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      const table = await createWorkspaceTable(db, {
        firstColumnName: 'Headcount',
        firstColumnValueType: 'text',
        name: 'Conversion prospects',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const sourceValues = ['42.5', ' 7 ', '', 'nope'] as const;
      const createdRows = [];
      for (const value of sourceValues) {
        const row = await createGridRow(db, {
          tableId: table.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        const cell = await writeGridCell(db, {
          columnId: table.firstColumn.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table.id,
          userId: owner!.id,
          value: value
            ? { type: 'text', value }
            : { type: 'empty' as const, value: null },
          workspaceId: workspace.id,
        });
        createdRows.push({ cell, row });
      }

      const blockedPreview = await previewColumnTypeConversion(db, {
        columnId: table.firstColumn.id,
        tableId: table.id,
        targetType: 'number',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(blockedPreview).toMatchObject({
        canConvert: false,
        impact: {
          convertibleCells: 2,
          emptyCells: 1,
          failedCells: 1,
          totalCells: 4,
        },
      });
      expect(blockedPreview.blockers).toContainEqual(
        expect.objectContaining({ code: 'conversion_failures', count: 1 })
      );
      expect(blockedPreview.failures).toEqual([
        expect.objectContaining({
          code: 'invalid_number',
          rowId: createdRows[3]!.row.id,
        }),
      ]);

      await writeGridCell(db, {
        columnId: table.firstColumn.id,
        expectedVersion: 1,
        rowId: createdRows[3]!.row.id,
        tableId: table.id,
        userId: owner!.id,
        value: { type: 'text', value: '9' },
        workspaceId: workspace.id,
      });
      const stalePreview = await previewColumnTypeConversion(db, {
        columnId: table.firstColumn.id,
        tableId: table.id,
        targetType: 'number',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(stalePreview.canConvert).toBe(true);

      await writeGridCell(db, {
        columnId: table.firstColumn.id,
        expectedVersion: 1,
        rowId: createdRows[0]!.row.id,
        tableId: table.id,
        userId: owner!.id,
        value: { type: 'text', value: '43' },
        workspaceId: workspace.id,
      });
      await expect(
        convertWorkspaceColumnType(db, {
          columnId: table.firstColumn.id,
          confirmationName: 'Headcount',
          previewDigest: stalePreview.previewDigest,
          tableId: table.id,
          targetType: 'number',
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridConflictError);

      const preview = await previewColumnTypeConversion(db, {
        columnId: table.firstColumn.id,
        tableId: table.id,
        targetType: 'number',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await expect(
        convertWorkspaceColumnType(db, {
          columnId: table.firstColumn.id,
          confirmationName: 'Wrong name',
          previewDigest: preview.previewDigest,
          tableId: table.id,
          targetType: 'number',
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridValidationError);

      await expect(
        convertWorkspaceColumnType(db, {
          columnId: table.firstColumn.id,
          confirmationName: 'Headcount',
          previewDigest: preview.previewDigest,
          tableId: table.id,
          targetType: 'number',
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).resolves.toMatchObject({
        convertedCells: 3,
        fromValueType: 'text',
        toValueType: 'number',
      });

      const snapshot = await getGridSnapshot(db, {
        tableId: table.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(
        snapshot.columns.find((column) => column.id === table.firstColumn.id)
      ).toMatchObject({ valueType: 'number' });
      expect(
        snapshot.rows.map(
          (row) =>
            row.cells[table.firstColumn.id]?.value ?? {
              type: 'empty',
              value: null,
            }
        )
      ).toEqual([
        { type: 'number', value: 43 },
        { type: 'number', value: 7 },
        { type: 'empty', value: null },
        { type: 'number', value: 9 },
      ]);

      const storedCells = await db
        .select({ rowId: cells.rowId, version: cells.version })
        .from(cells)
        .where(eq(cells.columnId, table.firstColumn.id));
      expect(
        Object.fromEntries(
          storedCells.map((cell) => [cell.rowId, cell.version])
        )
      ).toEqual({
        [createdRows[0]!.row.id]: 3,
        [createdRows[1]!.row.id]: 2,
        [createdRows[2]!.row.id]: 1,
        [createdRows[3]!.row.id]: 3,
      });
      const [event] = await db
        .select({
          action: schemaLifecycleEvents.action,
          snapshot: schemaLifecycleEvents.snapshot,
        })
        .from(schemaLifecycleEvents)
        .where(eq(schemaLifecycleEvents.columnId, table.firstColumn.id));
      expect(event).toMatchObject({
        action: 'column_type_converted',
        snapshot: {
          convertedCells: 3,
          failurePolicy: 'atomic',
          fromValueType: 'text',
          toValueType: 'number',
        },
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

  it('previews blockers, archives without data loss, restores, and audits actors', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, admin, member] = await db
        .insert(users)
        .values([
          {
            email: `lifecycle-owner-${crypto.randomUUID()}@example.test`,
            name: 'Lifecycle Owner',
          },
          {
            email: `lifecycle-admin-${crypto.randomUUID()}@example.test`,
            name: 'Lifecycle Admin',
          },
          {
            email: `lifecycle-member-${crypto.randomUUID()}@example.test`,
            name: 'Lifecycle Member',
          },
        ])
        .returning({ id: users.id, name: users.name });
      expect(owner).toBeDefined();
      expect(admin).toBeDefined();
      expect(member).toBeDefined();
      userIds.push(owner!.id, admin!.id, member!.id);

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      await db.insert(workspaceMembers).values([
        {
          role: 'admin',
          userId: admin!.id,
          workspaceId: workspace.id,
        },
        {
          role: 'member',
          userId: member!.id,
          workspaceId: workspace.id,
        },
      ]);

      const lifecycleTable = await createWorkspaceTable(db, {
        firstColumnName: 'Company',
        firstColumnValueType: 'text',
        name: 'Lifecycle prospects',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const domain = await createInputColumn(db, {
        name: 'Domain',
        tableId: lifecycleTable.id,
        userId: owner!.id,
        valueType: 'text',
        workspaceId: workspace.id,
      });
      const row = await createGridRow(db, {
        tableId: lifecycleTable.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: lifecycleTable.firstColumn.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId: lifecycleTable.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme' },
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: domain.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId: lifecycleTable.id,
        userId: owner!.id,
        value: { type: 'text', value: 'acme.example' },
        workspaceId: workspace.id,
      });
      const label = await createFormulaColumn(db, {
        name: 'Company label',
        source: 'CONCAT([Company], " · ", [Domain])',
        tableId: lifecycleTable.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });

      await expect(
        previewTableArchive(db, {
          tableId: lifecycleTable.id,
          userId: member!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridAccessError);
      expect(
        (
          await previewTableArchive(db, {
            tableId: lifecycleTable.id,
            userId: admin!.id,
            workspaceId: workspace.id,
          })
        ).canArchive
      ).toBe(true);

      const sourcePreview = await previewColumnArchive(db, {
        columnId: lifecycleTable.firstColumn.id,
        tableId: lifecycleTable.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(sourcePreview.canArchive).toBe(false);
      expect(sourcePreview.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'dependent_columns', count: 1 }),
        ])
      );

      const formulaPreview = await previewColumnArchive(db, {
        columnId: label.id,
        tableId: lifecycleTable.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(formulaPreview).toMatchObject({
        canArchive: true,
        impact: { cells: 1 },
      });
      await expect(
        archiveWorkspaceColumn(db, {
          columnId: label.id,
          confirmationName: 'Wrong',
          tableId: lifecycleTable.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridValidationError);

      await archiveWorkspaceColumn(db, {
        columnId: label.id,
        confirmationName: 'Company label',
        tableId: lifecycleTable.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(
        (
          await getGridSnapshot(db, {
            tableId: lifecycleTable.id,
            userId: owner!.id,
            workspaceId: workspace.id,
          })
        ).columns.some((column) => column.id === label.id)
      ).toBe(false);
      expect(
        await listArchivedTableColumns(db, {
          tableId: lifecycleTable.id,
          userId: admin!.id,
          workspaceId: workspace.id,
        })
      ).toEqual([
        expect.objectContaining({ id: label.id, name: 'Company label' }),
      ]);

      await restoreWorkspaceColumn(db, {
        columnId: label.id,
        tableId: lifecycleTable.id,
        userId: admin!.id,
        workspaceId: workspace.id,
      });
      expect(
        (
          await getGridSnapshot(db, {
            tableId: lifecycleTable.id,
            userId: owner!.id,
            workspaceId: workspace.id,
          })
        ).columns.some((column) => column.id === label.id)
      ).toBe(true);

      await archiveWorkspaceTable(db, {
        confirmationName: lifecycleTable.name,
        tableId: lifecycleTable.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await expect(
        getGridSnapshot(db, {
          tableId: lifecycleTable.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridAccessError);
      expect(
        (
          await listWorkspaceTables(db, {
            userId: owner!.id,
            workspaceId: workspace.id,
          })
        ).some((table) => table.id === lifecycleTable.id)
      ).toBe(false);
      expect(
        await listArchivedWorkspaceTables(db, {
          userId: admin!.id,
          workspaceId: workspace.id,
        })
      ).toEqual([
        expect.objectContaining({
          id: lifecycleTable.id,
          name: lifecycleTable.name,
        }),
      ]);

      const [starter] = await listWorkspaceTables(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const lastTablePreview = await previewTableArchive(db, {
        tableId: starter!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(lastTablePreview.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'last_table' }),
        ])
      );
      await expect(
        archiveWorkspaceTable(db, {
          confirmationName: starter!.name,
          tableId: starter!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridConflictError);

      await restoreWorkspaceTable(db, {
        tableId: lifecycleTable.id,
        userId: admin!.id,
        workspaceId: workspace.id,
      });
      const restored = await getGridSnapshot(db, {
        tableId: lifecycleTable.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(restored.rows).toHaveLength(1);
      expect(restored.columns).toHaveLength(3);

      const events = await db
        .select({
          action: schemaLifecycleEvents.action,
          actorUserId: schemaLifecycleEvents.actorUserId,
        })
        .from(schemaLifecycleEvents)
        .where(
          and(
            eq(schemaLifecycleEvents.workspaceId, workspace.id),
            eq(schemaLifecycleEvents.tableId, lifecycleTable.id)
          )
        );
      expect(events).toEqual(
        expect.arrayContaining([
          { action: 'column_archived', actorUserId: owner!.id },
          { action: 'column_restored', actorUserId: admin!.id },
          { action: 'table_archived', actorUserId: owner!.id },
          { action: 'table_restored', actorUserId: admin!.id },
        ])
      );
      const [storedFormula] = await db
        .select({ archivedAt: columns.archivedAt })
        .from(columns)
        .where(
          and(eq(columns.id, label.id), eq(columns.workspaceId, workspace.id))
        );
      expect(storedFormula?.archivedAt).toBeNull();
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

describe.skipIf(!testDatabaseUrl || !rlsDatabaseUrl)(
  'schema lifecycle row-level security',
  () => {
    it('writes and scopes audit events through the forced-RLS web role', async () => {
      const admin = createDatabase(testDatabaseUrl!);
      const web = createDatabase(rlsDatabaseUrl!);
      const userIds: string[] = [];
      const workspaceIds: string[] = [];

      try {
        const [ownerA, ownerB] = await admin.db
          .insert(users)
          .values([
            {
              email: `lifecycle-rls-a-${crypto.randomUUID()}@example.test`,
              name: 'Lifecycle RLS A',
            },
            {
              email: `lifecycle-rls-b-${crypto.randomUUID()}@example.test`,
              name: 'Lifecycle RLS B',
            },
          ])
          .returning({ id: users.id, name: users.name });
        expect(ownerA).toBeDefined();
        expect(ownerB).toBeDefined();
        userIds.push(ownerA!.id, ownerB!.id);

        const workspaceA = await ensurePersonalWorkspace(admin.db, ownerA!);
        const workspaceB = await ensurePersonalWorkspace(admin.db, ownerB!);
        workspaceIds.push(workspaceA.id, workspaceB.id);
        const archived = await createWorkspaceTable(admin.db, {
          firstColumnName: 'Name',
          firstColumnValueType: 'text',
          name: 'RLS archive target',
          userId: ownerA!.id,
          workspaceId: workspaceA.id,
        });

        await withAuthenticatedDatabase(web.db, ownerA!.id, (scopedDb) =>
          archiveWorkspaceTable(scopedDb, {
            confirmationName: archived.name,
            tableId: archived.id,
            userId: ownerA!.id,
            workspaceId: workspaceA.id,
          })
        );

        const visibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            scopedDb
              .select({ action: schemaLifecycleEvents.action })
              .from(schemaLifecycleEvents)
        );
        expect(visibleToOwnerA).toEqual([{ action: 'table_archived' }]);

        const visibleToOwnerB = await withAuthenticatedDatabase(
          web.db,
          ownerB!.id,
          (scopedDb) =>
            scopedDb
              .select({ action: schemaLifecycleEvents.action })
              .from(schemaLifecycleEvents)
        );
        expect(visibleToOwnerB).toEqual([]);
      } finally {
        if (workspaceIds.length > 0) {
          await admin.db
            .delete(workspaces)
            .where(inArray(workspaces.id, workspaceIds));
        }
        if (userIds.length > 0) {
          await admin.db.delete(users).where(inArray(users.id, userIds));
        }
        await Promise.all([admin.client.end(), web.client.end()]);
      }
    });
  }
);
