import { inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase, withAuthenticatedDatabase } from './client';
import {
  createGridRow,
  createInputColumn,
  createSavedGridView,
  deleteSavedGridView,
  ensurePersonalWorkspace,
  getGridSnapshot,
  GridAccessError,
  GridValidationError,
  listSavedGridViews,
  listWorkspaceTables,
  previewColumnArchive,
  updateSavedGridView,
  writeGridCell,
} from './index';
import { savedGridViews, users, workspaces } from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const rlsDatabaseUrl = process.env.RLS_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('saved typed grid views', () => {
  it('filters, sorts, paginates, validates dependencies, and remains tenant scoped', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `view-owner-${crypto.randomUUID()}@example.test`,
            name: 'View Owner',
          },
          {
            email: `view-outsider-${crypto.randomUUID()}@example.test`,
            name: 'View Outsider',
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
      const score = await createInputColumn(db, {
        name: 'Score',
        tableId: table!.id,
        userId: owner!.id,
        valueType: 'number',
        workspaceId: workspace.id,
      });
      const verified = await createInputColumn(db, {
        name: 'Verified',
        tableId: table!.id,
        userId: owner!.id,
        valueType: 'boolean',
        workspaceId: workspace.id,
      });
      const seenAt = await createInputColumn(db, {
        name: 'Seen at',
        tableId: table!.id,
        userId: owner!.id,
        valueType: 'timestamp',
        workspaceId: workspace.id,
      });

      for (const [name, value, isVerified, seenAtValue] of [
        ['Alpha', 50, true, '2026-01-03T00:00:00.000Z'],
        ['Beta', 40, false, '2026-01-04T00:00:00.000Z'],
        ['Gamma', 30, true, '2026-01-02T00:00:00.000Z'],
        ['Delta', 5, false, '2026-01-05T00:00:00.000Z'],
        ['Echo', 100, true, '2026-01-06T00:00:00.000Z'],
      ] as const) {
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
          value: { type: 'text', value: name },
          workspaceId: workspace.id,
        });
        await writeGridCell(db, {
          columnId: score.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'number', value },
          workspaceId: workspace.id,
        });
        await writeGridCell(db, {
          columnId: verified.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'boolean', value: isVerified },
          workspaceId: workspace.id,
        });
        await writeGridCell(db, {
          columnId: seenAt.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'timestamp', value: seenAtValue },
          workspaceId: workspace.id,
        });
      }
      const emptyScoreRow = await createGridRow(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: company.id,
        expectedVersion: 0,
        rowId: emptyScoreRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Aardvark' },
        workspaceId: workspace.id,
      });

      const view = await createSavedGridView(db, {
        filters: [
          {
            columnId: company.id,
            operator: 'text_contains',
            value: 'a',
          },
          { columnId: score.id, operator: 'number_gt', value: 10 },
        ],
        name: 'Qualified accounts',
        sort: { columnId: score.id, direction: 'desc' },
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(
        await listSavedGridViews(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).toEqual([
        expect.objectContaining({ id: view.id, name: 'Qualified accounts' }),
      ]);

      const first = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        { limit: 2, viewId: view.id }
      );
      const second = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        { cursor: first.pageInfo.nextCursor, limit: 2, viewId: view.id }
      );
      expect(first.activeView).toEqual({ id: view.id, name: view.name });
      expect(first.rows.map((row) => row.cells[score.id]?.value)).toEqual([
        { type: 'number', value: 50 },
        { type: 'number', value: 40 },
      ]);
      expect(second.rows.map((row) => row.cells[score.id]?.value)).toEqual([
        { type: 'number', value: 30 },
      ]);
      expect(second.pageInfo).toEqual({ hasMore: false, nextCursor: null });
      expect(
        new Set([...first.rows, ...second.rows].map((row) => row.id)).size
      ).toBe(3);

      const typedView = await createSavedGridView(db, {
        filters: [
          { columnId: verified.id, operator: 'boolean_is', value: true },
          {
            columnId: seenAt.id,
            operator: 'timestamp_after',
            value: '2026-01-02T00:00:00.000Z',
          },
        ],
        name: 'Recently verified',
        sort: { columnId: seenAt.id, direction: 'desc' },
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const typedFirstPage = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        { limit: 1, viewId: typedView.id }
      );
      const typedSecondPage = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        {
          cursor: typedFirstPage.pageInfo.nextCursor,
          limit: 1,
          viewId: typedView.id,
        }
      );
      expect(
        [...typedFirstPage.rows, ...typedSecondPage.rows].map(
          (row) =>
            (row.cells[company.id]?.value as { type: 'text'; value: string })
              .value
        )
      ).toEqual(['Echo', 'Alpha']);
      await deleteSavedGridView(db, {
        tableId: table!.id,
        userId: owner!.id,
        viewId: typedView.id,
        workspaceId: workspace.id,
      });

      const nestedView = await createSavedGridView(db, {
        filterTree: {
          children: [
            {
              children: [
                {
                  columnId: verified.id,
                  operator: 'boolean_is',
                  value: true,
                },
                { columnId: score.id, operator: 'number_gt', value: 80 },
              ],
              combinator: 'and',
            },
            {
              children: [
                {
                  columnId: verified.id,
                  operator: 'boolean_is',
                  value: false,
                },
                { columnId: score.id, operator: 'number_lt', value: 10 },
              ],
              combinator: 'and',
            },
          ],
          combinator: 'or',
        },
        name: 'High confidence or low score',
        sort: { columnId: company.id, direction: 'asc' },
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const nestedSnapshot = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        { viewId: nestedView.id }
      );
      expect(
        nestedSnapshot.rows.map(
          (row) =>
            (row.cells[company.id]?.value as { type: 'text'; value: string })
              .value
        )
      ).toEqual(['Delta', 'Echo']);
      await deleteSavedGridView(db, {
        tableId: table!.id,
        userId: owner!.id,
        viewId: nestedView.id,
        workspaceId: workspace.id,
      });

      await expect(
        getGridSnapshot(
          db,
          { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
          { cursor: first.pageInfo.nextCursor, limit: 2 }
        )
      ).rejects.toBeInstanceOf(GridValidationError);
      const emptyLastView = await createSavedGridView(db, {
        filters: [{ columnId: company.id, operator: 'is_not_empty' }],
        name: 'Empty scores last',
        sort: { columnId: score.id, direction: 'asc' },
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const nonEmptyPage = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        { limit: 5, viewId: emptyLastView.id }
      );
      const emptyPage = await getGridSnapshot(
        db,
        { tableId: table!.id, userId: owner!.id, workspaceId: workspace.id },
        {
          cursor: nonEmptyPage.pageInfo.nextCursor,
          limit: 5,
          viewId: emptyLastView.id,
        }
      );
      expect(
        nonEmptyPage.rows.map((row) => row.cells[score.id]?.value)
      ).toEqual([
        { type: 'number', value: 5 },
        { type: 'number', value: 30 },
        { type: 'number', value: 40 },
        { type: 'number', value: 50 },
        { type: 'number', value: 100 },
      ]);
      expect(emptyPage.rows.map((row) => row.id)).toEqual([emptyScoreRow.id]);
      await deleteSavedGridView(db, {
        tableId: table!.id,
        userId: owner!.id,
        viewId: emptyLastView.id,
        workspaceId: workspace.id,
      });
      await expect(
        createSavedGridView(db, {
          filters: [{ columnId: company.id, operator: 'number_gt', value: 1 }],
          name: 'Wrong type',
          sort: null,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridValidationError);
      await expect(
        listSavedGridViews(db, {
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(GridAccessError);

      const archivePreview = await previewColumnArchive(db, {
        columnId: score.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(archivePreview.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'saved_views', count: 1 }),
        ])
      );

      const updated = await updateSavedGridView(db, {
        filters: [{ columnId: company.id, operator: 'is_not_empty' }],
        name: 'Named accounts',
        sort: { columnId: company.id, direction: 'asc' },
        tableId: table!.id,
        userId: owner!.id,
        viewId: view.id,
        workspaceId: workspace.id,
      });
      expect(updated.name).toBe('Named accounts');
      expect(
        (
          await getGridSnapshot(
            db,
            {
              tableId: table!.id,
              userId: owner!.id,
              workspaceId: workspace.id,
            },
            { viewId: updated.id }
          )
        ).rows.map(
          (row) =>
            (row.cells[company.id]?.value as { type: 'text'; value: string })
              .value
        )
      ).toEqual(['Aardvark', 'Alpha', 'Beta', 'Delta', 'Echo', 'Gamma']);
      expect(
        (
          await previewColumnArchive(db, {
            columnId: score.id,
            tableId: table!.id,
            userId: owner!.id,
            workspaceId: workspace.id,
          })
        ).blockers.some((blocker) => blocker.code === 'saved_views')
      ).toBe(false);
      expect(
        await deleteSavedGridView(db, {
          tableId: table!.id,
          userId: owner!.id,
          viewId: view.id,
          workspaceId: workspace.id,
        })
      ).toEqual({ id: view.id });
    } finally {
      if (workspaceIds.length > 0)
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      if (userIds.length > 0)
        await db.delete(users).where(inArray(users.id, userIds));
      await client.end();
    }
  });

  it.runIf(Boolean(rlsDatabaseUrl))(
    'allows member-scoped writes through forced RLS and hides other workspaces',
    async () => {
      const { client: adminClient, db: adminDb } = createDatabase(
        testDatabaseUrl!
      );
      const { client: webClient, db: webDb } = createDatabase(rlsDatabaseUrl!);
      const userIds: string[] = [];
      const workspaceIds: string[] = [];
      try {
        const [owner, outsider] = await adminDb
          .insert(users)
          .values([
            {
              email: `view-rls-owner-${crypto.randomUUID()}@example.test`,
              name: 'View RLS Owner',
            },
            {
              email: `view-rls-outsider-${crypto.randomUUID()}@example.test`,
              name: 'View RLS Outsider',
            },
          ])
          .returning({ id: users.id, name: users.name });
        userIds.push(owner!.id, outsider!.id);
        const workspace = await ensurePersonalWorkspace(adminDb, owner!);
        workspaceIds.push(workspace.id);
        const [table] = await listWorkspaceTables(adminDb, {
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        const [column] = (
          await getGridSnapshot(adminDb, {
            tableId: table!.id,
            userId: owner!.id,
            workspaceId: workspace.id,
          })
        ).columns;

        const created = await withAuthenticatedDatabase(
          webDb,
          owner!.id,
          (scopedDb) =>
            createSavedGridView(scopedDb, {
              filters: [{ columnId: column!.id, operator: 'is_not_empty' }],
              name: 'RLS view',
              sort: null,
              tableId: table!.id,
              userId: owner!.id,
              workspaceId: workspace.id,
            })
        );
        expect(created.createdByUserId).toBe(owner!.id);
        const visibleToOwner = await withAuthenticatedDatabase(
          webDb,
          owner!.id,
          (scopedDb) => scopedDb.select().from(savedGridViews)
        );
        const visibleToOutsider = await withAuthenticatedDatabase(
          webDb,
          outsider!.id,
          (scopedDb) => scopedDb.select().from(savedGridViews)
        );
        expect(visibleToOwner.map((item) => item.id)).toContain(created.id);
        expect(visibleToOutsider.map((item) => item.id)).not.toContain(
          created.id
        );
      } finally {
        if (workspaceIds.length > 0)
          await adminDb
            .delete(workspaces)
            .where(inArray(workspaces.id, workspaceIds));
        if (userIds.length > 0)
          await adminDb.delete(users).where(inArray(users.id, userIds));
        await Promise.all([adminClient.end(), webClient.end()]);
      }
    }
  );
});
