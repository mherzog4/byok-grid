import { and, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase, withAuthenticatedDatabase } from './client';
import {
  createGridRow,
  ensurePersonalWorkspace,
  previewWorkspacePurge,
  purgeWorkspace,
  WorkspacePurgeAccessError,
  WorkspacePurgeConflictError,
  writeGridCell,
} from './index';
import {
  cells,
  columns,
  dataTables,
  importJobs,
  outboxEvents,
  rows,
  users,
  workspaceMembers,
  workspacePurgeHolds,
  workspacePurgeReceipts,
  workspaces,
} from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const rlsDatabaseUrl = process.env.RLS_DATABASE_URL;

describe.skipIf(!testDatabaseUrl || !rlsDatabaseUrl)(
  'workspace purge lifecycle',
  () => {
    it('limits purge-table grants to each runtime role', async () => {
      const admin = createDatabase(testDatabaseUrl!);

      try {
        const privileges = await admin.db.execute<{
          canDelete: boolean;
          canInsert: boolean;
          canSelect: boolean;
          canUpdate: boolean;
          roleName: string;
          tableName: string;
        }>(sql`
          select
            role_name as "roleName",
            table_name as "tableName",
            has_table_privilege(role_name, table_name, 'SELECT') as "canSelect",
            has_table_privilege(role_name, table_name, 'INSERT') as "canInsert",
            has_table_privilege(role_name, table_name, 'UPDATE') as "canUpdate",
            has_table_privilege(role_name, table_name, 'DELETE') as "canDelete"
          from (values
            ('byok_grid_web', 'workspace_purge_holds'),
            ('byok_grid_web', 'workspace_purge_receipts'),
            ('byok_grid_worker', 'workspace_purge_holds'),
            ('byok_grid_worker', 'workspace_purge_receipts')
          ) as checked(role_name, table_name)
          order by role_name, table_name
        `);

        expect(privileges).toEqual([
          {
            canDelete: false,
            canInsert: false,
            canSelect: true,
            canUpdate: false,
            roleName: 'byok_grid_web',
            tableName: 'workspace_purge_holds',
          },
          {
            canDelete: false,
            canInsert: true,
            canSelect: true,
            canUpdate: false,
            roleName: 'byok_grid_web',
            tableName: 'workspace_purge_receipts',
          },
          {
            canDelete: false,
            canInsert: false,
            canSelect: false,
            canUpdate: false,
            roleName: 'byok_grid_worker',
            tableName: 'workspace_purge_holds',
          },
          {
            canDelete: false,
            canInsert: false,
            canSelect: true,
            canUpdate: true,
            roleName: 'byok_grid_worker',
            tableName: 'workspace_purge_receipts',
          },
        ]);
      } finally {
        await admin.client.end();
      }
    });

    it('previews, blocks, erases cascades, and retains only an opaque receipt', async () => {
      const admin = createDatabase(testDatabaseUrl!);
      const web = createDatabase(rlsDatabaseUrl!);
      const userIds: string[] = [];
      const workspaceIds: string[] = [];
      const receiptIds: string[] = [];

      try {
        const [owner, workspaceAdmin, outsider, neighborOwner] = await admin.db
          .insert(users)
          .values([
            {
              email: `purge-owner-${crypto.randomUUID()}@example.test`,
              name: 'Purge Owner',
            },
            {
              email: `purge-admin-${crypto.randomUUID()}@example.test`,
              name: 'Purge Admin',
            },
            {
              email: `purge-outsider-${crypto.randomUUID()}@example.test`,
              name: 'Purge Outsider',
            },
            {
              email: `purge-neighbor-${crypto.randomUUID()}@example.test`,
              name: 'Neighbor Owner',
            },
          ])
          .returning({ id: users.id, name: users.name });
        expect(owner).toBeDefined();
        expect(workspaceAdmin).toBeDefined();
        expect(outsider).toBeDefined();
        expect(neighborOwner).toBeDefined();
        userIds.push(
          owner!.id,
          workspaceAdmin!.id,
          outsider!.id,
          neighborOwner!.id
        );

        const workspace = await ensurePersonalWorkspace(admin.db, owner!);
        const neighbor = await ensurePersonalWorkspace(
          admin.db,
          neighborOwner!
        );
        workspaceIds.push(workspace.id, neighbor.id);
        await admin.db.insert(workspaceMembers).values({
          role: 'admin',
          userId: workspaceAdmin!.id,
          workspaceId: workspace.id,
        });

        const [table] = await admin.db
          .select({ id: dataTables.id })
          .from(dataTables)
          .where(eq(dataTables.workspaceId, workspace.id))
          .limit(1);
        const [column] = await admin.db
          .select({ id: columns.id })
          .from(columns)
          .where(eq(columns.tableId, table!.id))
          .limit(1);
        const firstRow = await createGridRow(admin.db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        await writeGridCell(admin.db, {
          columnId: column!.id,
          expectedVersion: 0,
          rowId: firstRow.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'text', value: 'must be erased' },
          workspaceId: workspace.id,
        });
        const [activeImport] = await admin.db
          .insert(importJobs)
          .values({
            createdByUserId: owner!.id,
            filename: 'purge-proof.csv',
            tableId: table!.id,
            workspaceId: workspace.id,
          })
          .returning({ id: importJobs.id });
        await admin.db.insert(outboxEvents).values({
          aggregateId: crypto.randomUUID(),
          aggregateType: 'workspace_purge_test',
          eventType: 'cell_run_succeeded',
          payload: {},
          workspaceId: workspace.id,
        });

        await expect(
          withAuthenticatedDatabase(web.db, workspaceAdmin!.id, (scopedDb) =>
            previewWorkspacePurge(scopedDb, {
              userId: workspaceAdmin!.id,
              workspaceId: workspace.id,
            })
          )
        ).rejects.toBeInstanceOf(WorkspacePurgeAccessError);
        await expect(
          withAuthenticatedDatabase(web.db, outsider!.id, (scopedDb) =>
            previewWorkspacePurge(scopedDb, {
              userId: outsider!.id,
              workspaceId: workspace.id,
            })
          )
        ).rejects.toBeInstanceOf(WorkspacePurgeAccessError);

        const blocked = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (scopedDb) =>
            previewWorkspacePurge(scopedDb, {
              userId: owner!.id,
              workspaceId: workspace.id,
            })
        );
        expect(blocked.canPurge).toBe(false);
        expect(blocked.blockers).toEqual([
          expect.objectContaining({ code: 'active_work', count: 1 }),
        ]);
        expect(blocked.impact).toMatchObject({
          auditRecords: 1,
          cells: 1,
          columns: 2,
          executionRecords: 1,
          members: 2,
          rows: 1,
          tables: 1,
        });

        await admin.db
          .update(importJobs)
          .set({ status: 'cancelled' })
          .where(eq(importJobs.id, activeImport!.id));
        const stalePreview = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (scopedDb) =>
            previewWorkspacePurge(scopedDb, {
              userId: owner!.id,
              workspaceId: workspace.id,
            })
        );
        expect(stalePreview.canPurge).toBe(true);

        await createGridRow(admin.db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        await expect(
          withAuthenticatedDatabase(web.db, owner!.id, (scopedDb) =>
            purgeWorkspace(scopedDb, {
              acknowledgeIrreversible: true,
              confirmationName: workspace.name,
              previewDigest: stalePreview.previewDigest,
              reason: 'test_data',
              userId: owner!.id,
              workspaceId: workspace.id,
            })
          )
        ).rejects.toBeInstanceOf(WorkspacePurgeConflictError);

        await admin.db.insert(workspacePurgeHolds).values({
          placedBy: 'integration-test-operator',
          reason: 'Required integration test retention hold.',
          workspaceId: workspace.id,
        });
        const held = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (scopedDb) =>
            previewWorkspacePurge(scopedDb, {
              userId: owner!.id,
              workspaceId: workspace.id,
            })
        );
        expect(held.blockers).toEqual([
          expect.objectContaining({ code: 'legal_hold' }),
        ]);
        const directDelete = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (scopedDb) =>
            scopedDb
              .delete(workspaces)
              .where(eq(workspaces.id, workspace.id))
              .returning({ id: workspaces.id })
        );
        expect(directDelete).toEqual([]);
        await expect(
          withAuthenticatedDatabase(web.db, owner!.id, (scopedDb) =>
            purgeWorkspace(scopedDb, {
              acknowledgeIrreversible: true,
              confirmationName: workspace.name,
              previewDigest: held.previewDigest,
              reason: 'test_data',
              userId: owner!.id,
              workspaceId: workspace.id,
            })
          )
        ).rejects.toBeInstanceOf(WorkspacePurgeConflictError);

        await admin.db
          .delete(workspacePurgeHolds)
          .where(eq(workspacePurgeHolds.workspaceId, workspace.id));
        const ready = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (scopedDb) =>
            previewWorkspacePurge(scopedDb, {
              userId: owner!.id,
              workspaceId: workspace.id,
            })
        );
        expect(ready).toMatchObject({ canPurge: true });
        expect(ready.impact.rows).toBe(2);
        const receipt = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (scopedDb) =>
            purgeWorkspace(scopedDb, {
              acknowledgeIrreversible: true,
              confirmationName: workspace.name,
              previewDigest: ready.previewDigest,
              reason: 'test_data',
              userId: owner!.id,
              workspaceId: workspace.id,
            })
        );
        receiptIds.push(receipt.id);
        workspaceIds.splice(workspaceIds.indexOf(workspace.id), 1);
        expect(receipt).toMatchObject({
          actorUserId: owner!.id,
          impact: expect.objectContaining({ cells: 1, rows: 2 }),
          reason: 'test_data',
          workspaceId: workspace.id,
        });

        expect(
          await admin.db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, workspace.id))
        ).toEqual([]);
        expect(
          await admin.db
            .select({ id: rows.id })
            .from(rows)
            .where(eq(rows.workspaceId, workspace.id))
        ).toEqual([]);
        expect(
          await admin.db
            .select({ id: cells.id })
            .from(cells)
            .where(eq(cells.workspaceId, workspace.id))
        ).toEqual([]);
        expect(
          await admin.db
            .select({ id: outboxEvents.id })
            .from(outboxEvents)
            .where(eq(outboxEvents.workspaceId, workspace.id))
        ).toEqual([]);
        expect(
          await admin.db
            .select({ id: workspaces.id })
            .from(workspaces)
            .where(eq(workspaces.id, neighbor.id))
        ).toHaveLength(1);

        const ownerVisibleReceipt = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (scopedDb) =>
            scopedDb
              .select()
              .from(workspacePurgeReceipts)
              .where(eq(workspacePurgeReceipts.id, receipt.id))
        );
        expect(ownerVisibleReceipt).toHaveLength(1);
        expect(JSON.stringify(ownerVisibleReceipt)).not.toContain(
          workspace.name
        );
        const hiddenFromOtherActor = await withAuthenticatedDatabase(
          web.db,
          workspaceAdmin!.id,
          (scopedDb) =>
            scopedDb
              .select()
              .from(workspacePurgeReceipts)
              .where(eq(workspacePurgeReceipts.id, receipt.id))
        );
        expect(hiddenFromOtherActor).toEqual([]);

        await admin.db.delete(users).where(eq(users.id, owner!.id));
        userIds.splice(userIds.indexOf(owner!.id), 1);
        const [receiptWithoutActor] = await admin.db
          .select({ actorUserId: workspacePurgeReceipts.actorUserId })
          .from(workspacePurgeReceipts)
          .where(eq(workspacePurgeReceipts.id, receipt.id));
        expect(receiptWithoutActor?.actorUserId).toBeNull();
      } finally {
        if (receiptIds.length > 0) {
          await admin.db
            .delete(workspacePurgeReceipts)
            .where(inArray(workspacePurgeReceipts.id, receiptIds));
        }
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
