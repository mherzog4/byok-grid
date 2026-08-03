import { parseMasterKey } from '@byok-grid/security';
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase, withAuthenticatedDatabase } from './client';
import {
  BulkRunConflictError,
  cancelBulkRunBatch,
  createBulkRunBatch,
  createConnectorActionColumn,
  createEncryptedCredential,
  createGridRow,
  createHttpEnrichmentColumn,
  createSavedGridView,
  deleteSavedGridView,
  EnrichmentAccessError,
  EnrichmentValidationError,
  ensurePersonalWorkspace,
  expandBulkRunBatchChunk,
  getBulkRunBatch,
  listWorkspaceTables,
  previewBulkRun,
  queueEnrichmentCellRun,
  writeGridCell,
} from './index';
import {
  bulkRunItems,
  cellRuns,
  cells,
  columns,
  outboxEvents,
  users,
  workspaceMembers,
  workspaces,
} from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const rlsDatabaseUrl = process.env.RLS_DATABASE_URL;
const generousLimits = {
  maxOutputTokens: 10_000,
  maxProviderRequests: 100,
  maxRows: 100,
};

describe.skipIf(!testDatabaseUrl)('durable bulk enrichment runs', () => {
  it('freezes rows, enforces cost limits, resumes expansion, and isolates tenants', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const masterKey = parseMasterKey(
      'bulk-run-test-v1',
      randomBytes(32).toString('base64')
    );

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `bulk-owner-${crypto.randomUUID()}@example.test`,
            name: 'Bulk Owner',
          },
          {
            email: `bulk-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Bulk Outsider',
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
      const [domainColumn] = await db
        .select({ id: columns.id })
        .from(columns)
        .where(and(eq(columns.tableId, table!.id), eq(columns.name, 'Domain')));
      expect(domainColumn).toBeDefined();

      const testRows = [];
      for (let index = 0; index < 4; index += 1) {
        const row = await createGridRow(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        testRows.push(row);
        if (index !== 2) {
          await writeGridCell(db, {
            columnId: domainColumn!.id,
            expectedVersion: 0,
            rowId: row.id,
            tableId: table!.id,
            userId: owner!.id,
            value: { type: 'text', value: `company-${index}.example` },
            workspaceId: workspace.id,
          });
        }
      }

      const credential = await createEncryptedCredential(db, {
        connectorId: 'openai',
        masterKey,
        name: 'Bulk OpenAI key',
        secret: { apiKey: 'bulk-openai-key-must-not-enter-jobs' },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const aiColumn = await createConnectorActionColumn(db, {
        actionId: 'generate_text',
        connectorId: 'openai',
        credentialId: credential.id,
        inputBindings: {
          max_output_tokens: { kind: 'literal', value: 100 },
          model: { kind: 'literal', value: 'gpt-5.6-luna' },
          prompt: { columnId: domainColumn!.id, kind: 'column' },
        },
        name: 'Bulk AI summary',
        outputValueType: 'text',
        protocolVersion: '1.1',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await db.insert(cells).values({
        columnId: aiColumn.id,
        rowId: testRows[3]!.id,
        status: 'succeeded',
        tableId: table!.id,
        valueText: 'Existing result',
        valueType: 'text',
        workspaceId: workspace.id,
      });

      const preview = await previewBulkRun(db, {
        columnId: aiColumn.id,
        limits: generousLimits,
        mode: 'pending',
        rowLimit: 10,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(preview).toMatchObject({
        estimatedMaxOutputTokens: 1_000,
        estimatedProviderRequests: 10,
        excludedByModeRows: 1,
        inputReadyRows: 3,
        limitViolations: [],
        selectedRows: 2,
        totalRows: 4,
      });

      const limited = await previewBulkRun(db, {
        columnId: aiColumn.id,
        limits: { ...generousLimits, maxRows: 1 },
        mode: 'pending',
        rowLimit: 10,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(limited.limitViolations[0]).toContain('deployment limit is 1');

      await expect(
        createBulkRunBatch(db, {
          columnId: aiColumn.id,
          expectedSelectedRows: 1,
          expectedSelectionDigest: preview.selectionDigest,
          limits: generousLimits,
          mode: 'pending',
          rowLimit: 10,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(BulkRunConflictError);

      const batch = await createBulkRunBatch(db, {
        columnId: aiColumn.id,
        expectedSelectedRows: 2,
        expectedSelectionDigest: preview.selectionDigest,
        limits: generousLimits,
        mode: 'pending',
        rowLimit: 10,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(batch).toMatchObject({
        estimatedMaxOutputTokens: 1_000,
        estimatedProviderRequests: 10,
        selectedRowCount: 2,
        status: 'queued',
      });
      expect(
        await db
          .select()
          .from(bulkRunItems)
          .where(eq(bulkRunItems.batchId, batch.id))
      ).toHaveLength(2);
      const [batchEvent] = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, batch.id));
      expect(batchEvent).toMatchObject({
        eventType: 'column.bulk_run_requested',
        payload: { batchId: batch.id, workspaceId: workspace.id },
      });

      const firstChunk = await expandBulkRunBatchChunk(
        db,
        { batchId: batch.id, workspaceId: workspace.id },
        1
      );
      expect(firstChunk).toEqual({ processed: 1, status: 'running' });
      const secondChunk = await expandBulkRunBatchChunk(
        db,
        { batchId: batch.id, workspaceId: workspace.id },
        1
      );
      expect(secondChunk).toEqual({ processed: 1, status: 'completed' });

      const progress = await getBulkRunBatch(db, {
        batchId: batch.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(progress).toMatchObject({
        items: { pending: 0, queued: 2, skipped: 0 },
        queuedRowCount: 2,
        runs: { queued: 2 },
        status: 'completed',
      });
      await expect(
        cancelBulkRunBatch(db, {
          batchId: batch.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(BulkRunConflictError);
      const queuedRuns = await db
        .select()
        .from(cellRuns)
        .where(
          and(
            eq(cellRuns.connectorId, 'openai'),
            eq(cellRuns.workspaceId, workspace.id)
          )
        );
      expect(queuedRuns).toHaveLength(2);
      expect(JSON.stringify({ batchEvent, queuedRuns })).not.toContain(
        'bulk-openai-key-must-not-enter-jobs'
      );

      await expect(
        queueEnrichmentCellRun(db, {
          columnId: aiColumn.id,
          rowId: testRows[0]!.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(EnrichmentValidationError);

      await expect(
        previewBulkRun(db, {
          columnId: aiColumn.id,
          limits: generousLimits,
          mode: 'all',
          rowLimit: 10,
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(EnrichmentAccessError);
    } finally {
      if (workspaceIds.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      }
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }
      masterKey.value.fill(0);
      await client.end();
    }
  });

  it('freezes the exact sorted rows selected by a saved view', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const web = rlsDatabaseUrl ? createDatabase(rlsDatabaseUrl) : null;
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    try {
      const [owner, peerMember, outsider] = await db
        .insert(users)
        .values([
          {
            email: `view-bulk-owner-${crypto.randomUUID()}@example.test`,
            name: 'View Bulk Owner',
          },
          {
            email: `view-bulk-peer-${crypto.randomUUID()}@example.test`,
            name: 'View Bulk Peer',
          },
          {
            email: `view-bulk-outsider-${crypto.randomUUID()}@example.test`,
            name: 'View Bulk Outsider',
          },
        ])
        .returning({ id: users.id, name: users.name });
      userIds.push(owner!.id, peerMember!.id, outsider!.id);
      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      await db.insert(workspaceMembers).values({
        role: 'member',
        userId: peerMember!.id,
        workspaceId: workspace.id,
      });
      const [table] = await listWorkspaceTables(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const starterColumns = await db
        .select({ id: columns.id, name: columns.name })
        .from(columns)
        .where(eq(columns.tableId, table!.id));
      const company = starterColumns.find(
        (column) => column.name === 'Company'
      )!;
      const domain = starterColumns.find((column) => column.name === 'Domain')!;

      const fixtures = [
        { company: 'match-a', domain: 'z.example' },
        { company: 'match-b', domain: 'y.example' },
        { company: 'other', domain: 'x.example' },
        { company: 'match-c', domain: 'w.example' },
      ];
      const testRows = [];
      for (const fixture of fixtures) {
        const row = await createGridRow(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        testRows.push(row);
        await writeGridCell(db, {
          columnId: company.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'text', value: fixture.company },
          workspaceId: workspace.id,
        });
        await writeGridCell(db, {
          columnId: domain.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'text', value: fixture.domain },
          workspaceId: workspace.id,
        });
      }

      const enrichmentColumn = await createHttpEnrichmentColumn(db, {
        baseUrl: 'https://api.example.test/company',
        credentialId: null,
        inputColumnId: domain.id,
        name: 'View firmographics',
        queryParameter: 'domain',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const view = await createSavedGridView(db, {
        filterTree: {
          children: [
            {
              children: [
                {
                  columnId: company.id,
                  operator: 'text_equals',
                  value: 'match-a',
                },
                {
                  columnId: domain.id,
                  operator: 'text_equals',
                  value: 'z.example',
                },
              ],
              combinator: 'and',
            },
            {
              columnId: company.id,
              operator: 'text_equals',
              value: 'match-b',
            },
            {
              columnId: company.id,
              operator: 'text_equals',
              value: 'match-c',
            },
          ],
          combinator: 'or',
        },
        name: 'Qualified companies',
        sort: { columnId: domain.id, direction: 'desc' },
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const preview = await previewBulkRun(db, {
        columnId: enrichmentColumn.id,
        limits: generousLimits,
        mode: 'pending',
        rowLimit: 2,
        tableId: table!.id,
        userId: owner!.id,
        viewId: view.id,
        workspaceId: workspace.id,
      });
      expect(preview).toMatchObject({
        inputReadyRows: 3,
        scopedRows: 3,
        selectedRows: 2,
        selection: {
          kind: 'saved_view',
          name: 'Qualified companies',
          viewId: view.id,
        },
        totalRows: 4,
      });
      expect(preview.selectionDigest).toMatch(/^[0-9a-f]{64}$/);

      // Preserve the count while swapping one member of the selected set.
      await writeGridCell(db, {
        columnId: company.id,
        expectedVersion: 1,
        rowId: testRows[0]!.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'other-a' },
        workspaceId: workspace.id,
      });
      await expect(
        createBulkRunBatch(db, {
          columnId: enrichmentColumn.id,
          expectedSelectedRows: preview.selectedRows,
          expectedSelectionDigest: preview.selectionDigest,
          limits: generousLimits,
          mode: 'pending',
          rowLimit: 2,
          tableId: table!.id,
          userId: owner!.id,
          viewId: view.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(BulkRunConflictError);

      const refreshed = await previewBulkRun(db, {
        columnId: enrichmentColumn.id,
        limits: generousLimits,
        mode: 'pending',
        rowLimit: 2,
        tableId: table!.id,
        userId: owner!.id,
        viewId: view.id,
        workspaceId: workspace.id,
      });
      expect(refreshed.selectedRows).toBe(2);
      expect(refreshed.selectionDigest).not.toBe(preview.selectionDigest);
      const batch = await createBulkRunBatch(db, {
        columnId: enrichmentColumn.id,
        expectedSelectedRows: refreshed.selectedRows,
        expectedSelectionDigest: refreshed.selectionDigest,
        limits: generousLimits,
        mode: 'pending',
        rowLimit: 2,
        tableId: table!.id,
        userId: owner!.id,
        viewId: view.id,
        workspaceId: workspace.id,
      });
      const frozenItems = await db
        .select({ rowId: bulkRunItems.rowId })
        .from(bulkRunItems)
        .where(eq(bulkRunItems.batchId, batch.id))
        .orderBy(bulkRunItems.sequence);
      expect(frozenItems.map((item) => item.rowId)).toEqual([
        testRows[1]!.id,
        testRows[3]!.id,
      ]);

      expect(
        await expandBulkRunBatchChunk(
          db,
          { batchId: batch.id, workspaceId: workspace.id },
          1
        )
      ).toEqual({ processed: 1, status: 'running' });
      const [inFlightItem] = await db
        .select({ runId: bulkRunItems.runId })
        .from(bulkRunItems)
        .where(
          and(
            eq(bulkRunItems.batchId, batch.id),
            eq(bulkRunItems.status, 'queued')
          )
        );
      const [inFlightRun] = await db
        .select({ cellId: cellRuns.cellId, id: cellRuns.id })
        .from(cellRuns)
        .where(eq(cellRuns.id, inFlightItem!.runId!));
      await db
        .update(cellRuns)
        .set({ status: 'running' })
        .where(eq(cellRuns.id, inFlightRun!.id));
      await db
        .update(cells)
        .set({ status: 'running' })
        .where(eq(cells.id, inFlightRun!.cellId));

      const cancelAs = (userId: string) =>
        web
          ? withAuthenticatedDatabase(web.db, userId, (scopedDb) =>
              cancelBulkRunBatch(scopedDb, {
                batchId: batch.id,
                tableId: table!.id,
                userId,
                workspaceId: workspace.id,
              })
            )
          : cancelBulkRunBatch(db, {
              batchId: batch.id,
              tableId: table!.id,
              userId,
              workspaceId: workspace.id,
            });
      await expect(cancelAs(peerMember!.id)).rejects.toBeInstanceOf(
        EnrichmentAccessError
      );
      const cancelled = await cancelAs(owner!.id);
      expect(cancelled).toMatchObject({
        cancelledByUserId: owner!.id,
        queuedRowCount: 1,
        skippedRowCount: 1,
        status: 'cancelled',
      });
      expect(cancelled.cancelledAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(
        await cancelBulkRunBatch(db, {
          batchId: batch.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).toMatchObject({ cancelledAt: cancelled.cancelledAt });
      expect(
        await expandBulkRunBatchChunk(db, {
          batchId: batch.id,
          workspaceId: workspace.id,
        })
      ).toEqual({ processed: 0, status: 'cancelled' });
      expect(
        await getBulkRunBatch(db, {
          batchId: batch.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).toMatchObject({
        items: { pending: 0, queued: 1, skipped: 1 },
        runs: { cancelled: 1 },
        status: 'cancelled',
      });
      expect(
        await db
          .select({ status: cellRuns.status })
          .from(cellRuns)
          .where(eq(cellRuns.id, inFlightRun!.id))
      ).toEqual([{ status: 'cancelled' }]);
      expect(
        await db
          .select({ status: cells.status })
          .from(cells)
          .where(eq(cells.id, inFlightRun!.cellId))
      ).toEqual([{ status: 'cancelled' }]);
      expect(
        await db
          .update(cellRuns)
          .set({ status: 'succeeded' })
          .where(
            and(
              eq(cellRuns.id, inFlightRun!.id),
              eq(cellRuns.status, 'running')
            )
          )
          .returning({ id: cellRuns.id })
      ).toEqual([]);

      await deleteSavedGridView(db, {
        tableId: table!.id,
        userId: owner!.id,
        viewId: view.id,
        workspaceId: workspace.id,
      });
      expect(
        await getBulkRunBatch(db, {
          batchId: batch.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).toMatchObject({
        selection: {
          kind: 'saved_view',
          name: 'Qualified companies',
          viewId: view.id,
        },
        selectionDigest: refreshed.selectionDigest,
      });

      await expect(
        previewBulkRun(db, {
          columnId: enrichmentColumn.id,
          limits: generousLimits,
          mode: 'pending',
          rowLimit: 2,
          tableId: table!.id,
          userId: outsider!.id,
          viewId: view.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(EnrichmentAccessError);
    } finally {
      if (workspaceIds.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      }
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }
      await Promise.all([client.end(), web?.client.end()]);
    }
  });
});
