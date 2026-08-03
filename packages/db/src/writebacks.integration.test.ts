import { parseMasterKey } from '@byok-grid/security';
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  cells,
  columns,
  createEncryptedCredential,
  createGridRow,
  createInputColumn,
  createWritebackDestination,
  ensurePersonalWorkspace,
  listWorkspaceTables,
  listWritebackDestinations,
  markWritebackDeliveryRunning,
  markWritebackDeliverySucceeded,
  outboxEvents,
  processRowSettlement,
  previewColumnArchive,
  queueWritebackDelivery,
  rowSettlements,
  setWritebackDeliveryWorkerFailure,
  setWritebackDestinationStatus,
  users,
  workspaces,
  writebackDeliveries,
  WritebackAccessError,
  WritebackConflictError,
  writeGridCell,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('durable HubSpot writebacks', () => {
  it('freezes mappings, deduplicates commands, audits retries, and isolates tenants', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const masterKey = parseMasterKey(
      'writeback-test-v1',
      randomBytes(32).toString('base64')
    );
    const accessToken = 'synthetic-hubspot-private-app-token';

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `writeback-owner-${crypto.randomUUID()}@example.test`,
            name: 'Writeback Owner',
          },
          {
            email: `writeback-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Writeback Outsider',
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
      const tableColumns = await db
        .select({ id: columns.id, name: columns.name })
        .from(columns)
        .where(
          and(
            eq(columns.tableId, table!.id),
            eq(columns.workspaceId, workspace.id)
          )
        );
      const company = tableColumns.find((column) => column.name === 'Company')!;
      const domain = tableColumns.find((column) => column.name === 'Domain')!;
      const score = await createInputColumn(db, {
        name: 'Qualification score',
        tableId: table!.id,
        userId: owner!.id,
        valueType: 'number',
        workspaceId: workspace.id,
      });
      const [firstRow, secondRow] = await Promise.all([
        createGridRow(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        }),
        createGridRow(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        }),
      ]);
      await writeGridCell(db, {
        columnId: company.id,
        expectedVersion: 0,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme' },
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: domain.id,
        expectedVersion: 0,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: '12345' },
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: score.id,
        expectedVersion: 0,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'number', value: 90 },
        workspaceId: workspace.id,
      });
      const credential = await createEncryptedCredential(db, {
        connectorId: 'hubspot',
        masterKey,
        name: 'HubSpot production',
        secret: { accessToken },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const destination = await createWritebackDestination(db, {
        credentialId: credential.id,
        fieldMappings: [{ columnId: company.id, propertyName: 'company' }],
        name: 'Update contacts',
        recordIdColumnId: domain.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(destination).toMatchObject({
        adapterId: 'hubspot_contact',
        name: 'Update contacts',
        status: 'active',
      });
      await expect(
        createWritebackDestination(db, {
          credentialId: credential.id,
          fieldMappings: [{ columnId: company.id, propertyName: 'company' }],
          name: 'Stolen writeback',
          recordIdColumnId: domain.id,
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(WritebackAccessError);

      const deliveryId = crypto.randomUUID();
      const queueInput = {
        deliveryId,
        destinationId: destination.id,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      };
      const queued = await queueWritebackDelivery(db, queueInput);
      expect(queued).toMatchObject({
        id: deliveryId,
        rowId: firstRow.id,
        status: 'queued',
      });
      await expect(
        queueWritebackDelivery(db, queueInput)
      ).resolves.toMatchObject({ id: deliveryId });
      await expect(
        queueWritebackDelivery(db, { ...queueInput, rowId: secondRow.id })
      ).rejects.toBeInstanceOf(WritebackConflictError);

      const [stored] = await db
        .select()
        .from(writebackDeliveries)
        .where(eq(writebackDeliveries.id, deliveryId));
      expect(stored?.payload).toMatchObject({
        adapterId: 'hubspot_contact',
        deliveryId,
        properties: { company: 'Acme' },
        recordId: '12345',
        row: { id: firstRow.id },
        workspaceId: workspace.id,
      });
      const requested = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateId, deliveryId),
            eq(outboxEvents.eventType, 'table.writeback_delivery_requested')
          )
        );
      expect(requested).toHaveLength(1);
      expect(JSON.stringify({ destination, requested, stored })).not.toContain(
        accessToken
      );

      const workerInput = {
        deliveryId,
        destinationId: destination.id,
        tableId: table!.id,
        workspaceId: workspace.id,
      };
      expect(await markWritebackDeliveryRunning(db, workerInput)).toBe('ready');
      await setWritebackDeliveryWorkerFailure(db, {
        ...workerInput,
        errorCode: 'rate_limited',
        errorMessage: 'Retry later.',
        responseStatus: 429,
        retrying: true,
      });
      expect(await markWritebackDeliveryRunning(db, workerInput)).toBe('ready');
      await markWritebackDeliverySucceeded(db, {
        ...workerInput,
        responseStatus: 200,
      });
      expect(await markWritebackDeliveryRunning(db, workerInput)).toBe(
        'succeeded'
      );

      const listed = await listWritebackDestinations(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(listed[0]).toMatchObject({
        id: destination.id,
        lastDelivery: {
          attempt: 2,
          id: deliveryId,
          responseStatus: 200,
          status: 'succeeded',
        },
      });

      const automaticDestination = await createWritebackDestination(db, {
        credentialId: credential.id,
        fieldMappings: [{ columnId: company.id, propertyName: 'company' }],
        filterTree: {
          children: [
            {
              columnId: score.id,
              operator: 'number_gt',
              value: 80,
            },
          ],
          combinator: 'and',
        },
        name: 'Automatically update qualified contacts',
        recordIdColumnId: domain.id,
        tableId: table!.id,
        triggerMode: 'row_settled',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(
        await previewColumnArchive(db, {
          columnId: score.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).toMatchObject({
        blockers: expect.arrayContaining([
          expect.objectContaining({ code: 'writeback_mappings', count: 1 }),
        ]),
        canArchive: false,
      });
      const notes = await createInputColumn(db, {
        name: 'Internal notes',
        tableId: table!.id,
        userId: owner!.id,
        valueType: 'text',
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: notes.id,
        expectedVersion: 0,
        rowId: secondRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Does not affect CRM' },
        workspaceId: workspace.id,
      });
      expect(
        await db
          .select()
          .from(rowSettlements)
          .where(eq(rowSettlements.rowId, secondRow.id))
      ).toHaveLength(0);
      await writeGridCell(db, {
        columnId: company.id,
        expectedVersion: 1,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Qualified Acme' },
        workspaceId: workspace.id,
      });
      const [qualifiedSettlement] = await db
        .select()
        .from(rowSettlements)
        .where(
          and(
            eq(rowSettlements.rowId, firstRow.id),
            eq(rowSettlements.rowVersion, 5)
          )
        );
      await expect(
        processRowSettlement(
          db,
          settlementInput(qualifiedSettlement!, table!.id, workspace.id),
          {
            maximumAutomaticWritebacks: 5,
          }
        )
      ).resolves.toEqual({
        queuedDeliveryCount: 1,
        queuedRunCount: 0,
        status: 'succeeded',
      });
      const [automaticDelivery] = await db
        .select()
        .from(writebackDeliveries)
        .where(eq(writebackDeliveries.destinationId, automaticDestination.id));
      expect(automaticDelivery).toMatchObject({
        filterTreeSnapshot: automaticDestination.filterTree,
        rowVersion: 5,
        triggerMode: 'row_settled',
      });
      expect(automaticDelivery?.payloadFingerprint).toMatch(/^[0-9a-f]{64}$/);

      // A source loop writing identical values creates a new row version, but
      // the semantic payload fingerprint suppresses the duplicate writeback.
      await writeGridCell(db, {
        columnId: company.id,
        expectedVersion: 2,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Qualified Acme' },
        workspaceId: workspace.id,
      });
      const [duplicateSettlement] = await db
        .select()
        .from(rowSettlements)
        .where(
          and(
            eq(rowSettlements.rowId, firstRow.id),
            eq(rowSettlements.rowVersion, 6)
          )
        );
      await expect(
        processRowSettlement(
          db,
          settlementInput(duplicateSettlement!, table!.id, workspace.id)
        )
      ).resolves.toMatchObject({ queuedDeliveryCount: 0, status: 'succeeded' });

      for (const suffix of ['B', 'C']) {
        await createWritebackDestination(db, {
          credentialId: credential.id,
          fieldMappings: [{ columnId: company.id, propertyName: 'company' }],
          filterTree: automaticDestination.filterTree,
          name: `Automatic qualified contacts ${suffix}`,
          recordIdColumnId: domain.id,
          tableId: table!.id,
          triggerMode: 'row_settled',
          userId: owner!.id,
          workspaceId: workspace.id,
        });
      }
      await writeGridCell(db, {
        columnId: company.id,
        expectedVersion: 3,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Qualified Acme updated' },
        workspaceId: workspace.id,
      });
      const [fanoutSettlement] = await db
        .select()
        .from(rowSettlements)
        .where(
          and(
            eq(rowSettlements.rowId, firstRow.id),
            eq(rowSettlements.rowVersion, 7)
          )
        );
      await expect(
        processRowSettlement(
          db,
          settlementInput(fanoutSettlement!, table!.id, workspace.id),
          { maximumAutomaticWritebacks: 2 }
        )
      ).resolves.toEqual({
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'failed',
      });
      expect(
        await db
          .select()
          .from(writebackDeliveries)
          .where(
            and(
              eq(writebackDeliveries.rowId, firstRow.id),
              eq(writebackDeliveries.rowVersion, 7)
            )
          )
      ).toHaveLength(0);

      await db
        .update(cells)
        .set({ status: 'running' })
        .where(
          and(eq(cells.rowId, firstRow.id), eq(cells.columnId, company.id))
        );
      await expect(
        queueWritebackDelivery(db, {
          ...queueInput,
          deliveryId: crypto.randomUUID(),
        })
      ).rejects.toBeInstanceOf(WritebackConflictError);
      await db
        .update(cells)
        .set({ status: 'idle' })
        .where(
          and(eq(cells.rowId, firstRow.id), eq(cells.columnId, company.id))
        );
      await setWritebackDestinationStatus(db, {
        destinationId: destination.id,
        status: 'paused',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await expect(
        queueWritebackDelivery(db, {
          ...queueInput,
          deliveryId: crypto.randomUUID(),
        })
      ).rejects.toBeInstanceOf(WritebackConflictError);
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
