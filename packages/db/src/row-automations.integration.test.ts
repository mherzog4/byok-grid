import { parseMasterKey } from '@byok-grid/security';
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  cellRuns,
  cells,
  columns,
  createEncryptedCredential,
  createGridRow,
  createHttpEnrichmentColumn,
  createWebhookDestination,
  createWritebackDestination,
  ensurePersonalWorkspace,
  listWorkspaceTables,
  outboxEvents,
  processRowSettlement,
  recordRowMutationAndMaybeQueueSettlement,
  rowSettlements,
  users,
  webhookDeliveries,
  writebackDeliveries,
  workspaces,
  writeGridCell,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('dependency-driven row automation', () => {
  it('coalesces changes, runs direct dependents, and settles after completion', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const masterKey = parseMasterKey(
      'row-automation-test-v1',
      randomBytes(32).toString('base64')
    );
    try {
      const [owner] = await db
        .insert(users)
        .values({
          email: `row-automation-${crypto.randomUUID()}@example.test`,
          name: 'Row Automation Owner',
        })
        .returning({ id: users.id, name: users.name });
      userIds.push(owner!.id);
      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      const [table] = await listWorkspaceTables(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const [company] = await db
        .select({ id: columns.id })
        .from(columns)
        .where(
          and(
            eq(columns.tableId, table!.id),
            eq(columns.workspaceId, workspace.id),
            eq(columns.name, 'Company')
          )
        );
      await createHttpEnrichmentColumn(db, {
        baseUrl: 'https://api.example.test/manual-company',
        credentialId: null,
        inputColumnId: company!.id,
        name: 'Manual firmographics',
        queryParameter: 'company',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const manualOnlyRow = await createGridRow(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: company!.id,
        expectedVersion: 0,
        rowId: manualOnlyRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Manual only' },
        workspaceId: workspace.id,
      });
      expect(
        await db
          .select()
          .from(rowSettlements)
          .where(eq(rowSettlements.rowId, manualOnlyRow.id))
      ).toHaveLength(0);

      const credential = await createEncryptedCredential(db, {
        connectorId: 'webhook',
        masterKey,
        name: 'Automatic webhook signing',
        secret: { secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const destination = await createWebhookDestination(db, {
        name: 'Automatic CRM intake',
        signingCredentialId: credential.id,
        tableId: table!.id,
        triggerMode: 'row_settled',
        url: 'https://hooks.example.com/automatic-rows',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const hubSpotCredential = await createEncryptedCredential(db, {
        connectorId: 'hubspot',
        masterKey,
        name: 'Automatic HubSpot writeback',
        secret: { accessToken: 'synthetic-hubspot-token' },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const automaticWriteback = await createWritebackDestination(db, {
        credentialId: hubSpotCredential.id,
        fieldMappings: [{ columnId: company!.id, propertyName: 'company' }],
        filterTree: {
          children: [
            {
              columnId: company!.id,
              operator: 'text_equals',
              value: 'Acme',
            },
          ],
          combinator: 'and',
        },
        name: 'Qualified HubSpot contacts',
        recordIdColumnId: company!.id,
        tableId: table!.id,
        triggerMode: 'row_settled',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const automaticColumn = await createHttpEnrichmentColumn(db, {
        baseUrl: 'https://api.example.test/company',
        credentialId: null,
        inputColumnId: company!.id,
        name: 'Automatic firmographics',
        queryParameter: 'company',
        runMode: 'on_change',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const row = await createGridRow(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });

      await writeGridCell(db, {
        columnId: company!.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme' },
        workspaceId: workspace.id,
      });
      const [change] = await db
        .select()
        .from(rowSettlements)
        .where(eq(rowSettlements.rowId, row.id));
      expect(change).toMatchObject({
        changedColumnIds: [company!.id],
        rowVersion: 2,
        status: 'queued',
      });

      const automatic = await processRowSettlement(
        db,
        settlementInput(change!, table!.id, workspace.id),
        { maximumAutomaticRuns: 10 }
      );
      expect(automatic).toEqual({
        queuedDeliveryCount: 0,
        queuedRunCount: 1,
        status: 'succeeded',
      });
      const [automaticCell] = await db
        .select()
        .from(cells)
        .where(
          and(eq(cells.rowId, row.id), eq(cells.columnId, automaticColumn.id))
        );
      expect(automaticCell).toMatchObject({ status: 'queued' });
      expect(
        await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.destinationId, destination.id))
      ).toHaveLength(0);

      await db
        .update(cells)
        .set({
          status: 'succeeded',
          valueJson: { employeeCount: 42 },
          valueType: 'json',
        })
        .where(eq(cells.id, automaticCell!.id));
      const terminal = await recordRowMutationAndMaybeQueueSettlement(db, {
        changedColumnIds: [automaticColumn.id],
        rowId: row.id,
        tableId: table!.id,
        workspaceId: workspace.id,
      });
      const [terminalSettlement] = await db
        .select()
        .from(rowSettlements)
        .where(eq(rowSettlements.id, terminal.settlementId!));
      const settled = await processRowSettlement(
        db,
        settlementInput(terminalSettlement!, table!.id, workspace.id)
      );
      expect(settled).toEqual({
        queuedDeliveryCount: 2,
        queuedRunCount: 0,
        status: 'succeeded',
      });
      await expect(
        processRowSettlement(
          db,
          settlementInput(terminalSettlement!, table!.id, workspace.id)
        )
      ).resolves.toEqual(settled);
      const [settledWriteback] = await db
        .select()
        .from(writebackDeliveries)
        .where(eq(writebackDeliveries.destinationId, automaticWriteback.id));
      expect(settledWriteback).toMatchObject({
        rowVersion: 3,
        triggerMode: 'row_settled',
      });

      await writeGridCell(db, {
        columnId: company!.id,
        expectedVersion: 1,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme stale' },
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: company!.id,
        expectedVersion: 2,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme latest' },
        workspaceId: workspace.id,
      });
      const pendingChanges = await db
        .select()
        .from(rowSettlements)
        .where(
          and(
            eq(rowSettlements.rowId, row.id),
            inArray(rowSettlements.rowVersion, [4, 5])
          )
        );
      const stale = pendingChanges.find((item) => item.rowVersion === 4)!;
      const latest = pendingChanges.find((item) => item.rowVersion === 5)!;
      const [staleResult, latestResult] = await Promise.all([
        processRowSettlement(
          db,
          settlementInput(stale, table!.id, workspace.id)
        ),
        processRowSettlement(
          db,
          settlementInput(latest, table!.id, workspace.id)
        ),
      ]);
      expect(staleResult).toEqual({
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'skipped',
      });
      expect(latestResult).toEqual({
        queuedDeliveryCount: 0,
        queuedRunCount: 1,
        status: 'succeeded',
      });
      const [storedStale] = await db
        .select({ consumedById: rowSettlements.consumedById })
        .from(rowSettlements)
        .where(eq(rowSettlements.id, stale.id));
      expect(storedStale?.consumedById).toBe(latest.id);

      await writeGridCell(db, {
        columnId: company!.id,
        expectedVersion: 3,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme during active run' },
        workspaceId: workspace.id,
      });
      const [duringActive] = await db
        .select()
        .from(rowSettlements)
        .where(
          and(
            eq(rowSettlements.rowId, row.id),
            eq(rowSettlements.rowVersion, 6)
          )
        );
      await expect(
        processRowSettlement(
          db,
          settlementInput(duringActive!, table!.id, workspace.id)
        )
      ).resolves.toEqual({
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'skipped',
      });
      await db
        .update(cellRuns)
        .set({ finishedAt: new Date(), status: 'succeeded' })
        .where(eq(cellRuns.cellId, automaticCell!.id));
      await db
        .update(cells)
        .set({ status: 'succeeded' })
        .where(eq(cells.id, automaticCell!.id));
      const activeCompletion = await recordRowMutationAndMaybeQueueSettlement(
        db,
        {
          changedColumnIds: [automaticColumn.id],
          rowId: row.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        }
      );
      const [afterActive] = await db
        .select()
        .from(rowSettlements)
        .where(eq(rowSettlements.id, activeCompletion.settlementId!));
      await expect(
        processRowSettlement(
          db,
          settlementInput(afterActive!, table!.id, workspace.id)
        )
      ).resolves.toEqual({
        queuedDeliveryCount: 0,
        queuedRunCount: 1,
        status: 'succeeded',
      });
      const [storedDuringActive] = await db
        .select({ consumedById: rowSettlements.consumedById })
        .from(rowSettlements)
        .where(eq(rowSettlements.id, duringActive!.id));
      expect(storedDuringActive?.consumedById).toBe(afterActive!.id);

      for (const suffix of ['B', 'C']) {
        await createHttpEnrichmentColumn(db, {
          baseUrl: `https://api.example.test/company-${suffix.toLowerCase()}`,
          credentialId: null,
          inputColumnId: company!.id,
          name: `Automatic firmographics ${suffix}`,
          queryParameter: 'company',
          runMode: 'on_change',
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
      }
      const limitedRow = await createGridRow(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: company!.id,
        expectedVersion: 0,
        rowId: limitedRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Too much fan-out' },
        workspaceId: workspace.id,
      });
      const [limitedSettlement] = await db
        .select()
        .from(rowSettlements)
        .where(eq(rowSettlements.rowId, limitedRow.id));
      await expect(
        processRowSettlement(
          db,
          settlementInput(limitedSettlement!, table!.id, workspace.id),
          { maximumAutomaticRuns: 2 }
        )
      ).resolves.toEqual({
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'failed',
      });
      expect(
        await db
          .select()
          .from(cellRuns)
          .innerJoin(cells, eq(cells.id, cellRuns.cellId))
          .where(eq(cells.rowId, limitedRow.id))
      ).toHaveLength(0);

      const deliveries = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.destinationId, destination.id));
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]?.payload).toMatchObject({
        data: { row: { version: 3 } },
        trigger: { mode: 'row_settled', rowVersion: 3 },
      });
      const settlementEvents = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.eventType, 'table.row_settled'));
      expect(settlementEvents.length).toBeGreaterThanOrEqual(7);
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
});

function settlementInput(
  settlement: typeof rowSettlements.$inferSelect,
  tableId: string,
  workspaceId: string
) {
  return {
    rowId: settlement.rowId,
    rowVersion: settlement.rowVersion,
    settlementId: settlement.id,
    tableId,
    workspaceId,
  };
}
