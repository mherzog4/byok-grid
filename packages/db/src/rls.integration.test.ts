import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase, withAuthenticatedDatabase } from './client';
import {
  acceptWorkspaceInvitation,
  createWorkspaceInvitation,
} from './collaboration';
import { ensurePersonalWorkspace, listUserWorkspaces } from './workspaces';
import { setSourceStatus } from './sources';
import {
  createCsvImportJob,
  queueCsvImport,
  stageCsvImportRows,
} from './imports';
import {
  bulkRunBatches,
  columns,
  credentials,
  dataTables,
  rowSettlements,
  rows as gridRows,
  sourceDefinitions,
  sourceRecords,
  sourceRuns,
  users,
  webhookDeliveries,
  webhookDestinations,
  workspaces,
  writebackDeliveries,
  writebackDestinations,
} from './schema';

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const webDatabaseUrl = process.env.RLS_DATABASE_URL;
const workerDatabaseUrl = process.env.RLS_WORKER_DATABASE_URL;

describe.skipIf(!adminDatabaseUrl || !webDatabaseUrl || !workerDatabaseUrl)(
  'database-enforced tenant isolation',
  () => {
    it('scopes the web role transaction-locally while the worker bypass is explicit', async () => {
      const admin = createDatabase(adminDatabaseUrl!);
      const web = createDatabase(webDatabaseUrl!);
      const worker = createDatabase(workerDatabaseUrl!);
      const userIds: string[] = [];
      const workspaceIds: string[] = [];

      try {
        const [ownerA, ownerB, invitee] = await admin.db
          .insert(users)
          .values([
            {
              email: `rls-owner-a-${crypto.randomUUID()}@example.test`,
              name: 'RLS Owner A',
            },
            {
              email: `rls-owner-b-${crypto.randomUUID()}@example.test`,
              name: 'RLS Owner B',
            },
            {
              email: `rls-invitee-${crypto.randomUUID()}@example.test`,
              name: 'RLS Invitee',
            },
          ])
          .returning({ email: users.email, id: users.id, name: users.name });
        expect(ownerA).toBeDefined();
        expect(ownerB).toBeDefined();
        expect(invitee).toBeDefined();
        userIds.push(ownerA!.id, ownerB!.id, invitee!.id);

        const workspaceA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) => ensurePersonalWorkspace(scopedDb, ownerA!)
        );
        const workspaceB = await withAuthenticatedDatabase(
          web.db,
          ownerB!.id,
          (scopedDb) => ensurePersonalWorkspace(scopedDb, ownerB!)
        );
        workspaceIds.push(workspaceA.id, workspaceB.id);

        const starterTables = await admin.db
          .select({
            columnId: columns.id,
            tableId: dataTables.id,
            workspaceId: dataTables.workspaceId,
          })
          .from(dataTables)
          .innerJoin(columns, eq(columns.tableId, dataTables.id))
          .where(inArray(dataTables.workspaceId, workspaceIds));
        const firstColumnByWorkspace = new Map(
          starterTables.map((item) => [item.workspaceId, item])
        );
        const batchFixtures = await admin.db
          .insert(bulkRunBatches)
          .values(
            [workspaceA, workspaceB].map((workspace) => {
              const fixture = firstColumnByWorkspace.get(workspace.id)!;
              return {
                columnId: fixture.columnId,
                createdByUserId:
                  workspace.id === workspaceA.id ? ownerA!.id : ownerB!.id,
                estimatedProviderRequests: 0,
                mode: 'pending' as const,
                selectedRowCount: 0,
                tableId: fixture.tableId,
                workspaceId: workspace.id,
              };
            })
          )
          .returning({
            id: bulkRunBatches.id,
            workspaceId: bulkRunBatches.workspaceId,
          });
        const sourceFixtures = await admin.db
          .insert(sourceDefinitions)
          .values(
            [workspaceA, workspaceB].map((workspace) => {
              const fixture = firstColumnByWorkspace.get(workspace.id)!;
              return {
                createdByUserId:
                  workspace.id === workspaceA.id ? ownerA!.id : ownerB!.id,
                endpointUrl: 'https://api.example.com/companies',
                maxRecords: 100,
                name: 'RLS source',
                recordKeyField: 'id',
                tableId: fixture.tableId,
                workspaceId: workspace.id,
              };
            })
          )
          .returning({
            id: sourceDefinitions.id,
            tableId: sourceDefinitions.tableId,
            workspaceId: sourceDefinitions.workspaceId,
          });
        const sourceRowFixtures = await admin.db
          .insert(gridRows)
          .values(
            sourceFixtures.map((source) => ({
              position: `rls-source-${source.id}`,
              tableId: source.tableId,
              workspaceId: source.workspaceId,
            }))
          )
          .returning({
            id: gridRows.id,
            tableId: gridRows.tableId,
            workspaceId: gridRows.workspaceId,
          });
        const sourceRunFixtures = await admin.db
          .insert(sourceRuns)
          .values(
            sourceFixtures.map((source) => ({
              scheduledFor: new Date(),
              sourceId: source.id,
              tableId: source.tableId,
              trigger: 'manual' as const,
              workspaceId: source.workspaceId,
            }))
          )
          .returning({
            id: sourceRuns.id,
            sourceId: sourceRuns.sourceId,
            tableId: sourceRuns.tableId,
            workspaceId: sourceRuns.workspaceId,
          });
        await admin.db.insert(sourceRecords).values(
          sourceRunFixtures.map((run) => ({
            lastSeenRunId: run.id,
            recordKey: `record-${run.sourceId}`,
            rowId: sourceRowFixtures.find(
              (row) => row.workspaceId === run.workspaceId
            )!.id,
            sourceId: run.sourceId,
            tableId: run.tableId,
            workspaceId: run.workspaceId,
          }))
        );
        const webhookCredentials = await admin.db
          .insert(credentials)
          .values(
            [workspaceA, workspaceB].map((workspace) => ({
              connectorId: 'webhook',
              encryptedValue: {
                algorithm: 'A256GCM' as const,
                ciphertext: 'fixture',
                keyId: 'fixture',
                nonce: 'fixture',
                tag: 'fixture',
                version: 1 as const,
              },
              name: 'RLS webhook signing',
              workspaceId: workspace.id,
            }))
          )
          .returning({
            id: credentials.id,
            workspaceId: credentials.workspaceId,
          });
        const webhookDestinationFixtures = await admin.db
          .insert(webhookDestinations)
          .values(
            [workspaceA, workspaceB].map((workspace) => {
              const table = firstColumnByWorkspace.get(workspace.id)!;
              return {
                createdByUserId:
                  workspace.id === workspaceA.id ? ownerA!.id : ownerB!.id,
                endpointUrl: 'https://hooks.example.com/rows',
                name: 'RLS webhook',
                signingCredentialId: webhookCredentials.find(
                  (credential) => credential.workspaceId === workspace.id
                )!.id,
                tableId: table.tableId,
                workspaceId: workspace.id,
              };
            })
          )
          .returning({
            id: webhookDestinations.id,
            tableId: webhookDestinations.tableId,
            workspaceId: webhookDestinations.workspaceId,
          });
        await admin.db.insert(webhookDeliveries).values(
          webhookDestinationFixtures.map((destination) => {
            const id = crypto.randomUUID();
            const rowId = sourceRowFixtures.find(
              (row) => row.workspaceId === destination.workspaceId
            )!.id;
            return {
              destinationId: destination.id,
              id,
              payload: {
                data: {
                  row: { cells: [], id: rowId, version: 1 },
                  table: { id: destination.tableId, name: 'RLS table' },
                },
                deliveryId: id,
                event: 'row.delivered' as const,
                occurredAt: new Date().toISOString(),
                trigger: { mode: 'manual' as const, rowVersion: 1 },
                version: 1 as const,
                workspaceId: destination.workspaceId,
              },
              rowId,
              rowVersion: 1,
              tableId: destination.tableId,
              workspaceId: destination.workspaceId,
            };
          })
        );
        const hubSpotCredentials = await admin.db
          .insert(credentials)
          .values(
            [workspaceA, workspaceB].map((workspace) => ({
              connectorId: 'hubspot',
              encryptedValue: {
                algorithm: 'A256GCM' as const,
                ciphertext: 'fixture',
                keyId: 'fixture',
                nonce: 'fixture',
                tag: 'fixture',
                version: 1 as const,
              },
              name: 'RLS HubSpot token',
              workspaceId: workspace.id,
            }))
          )
          .returning({
            id: credentials.id,
            workspaceId: credentials.workspaceId,
          });
        const writebackDestinationFixtures = await admin.db
          .insert(writebackDestinations)
          .values(
            [workspaceA, workspaceB].map((workspace) => {
              const table = firstColumnByWorkspace.get(workspace.id)!;
              return {
                createdByUserId:
                  workspace.id === workspaceA.id ? ownerA!.id : ownerB!.id,
                credentialId: hubSpotCredentials.find(
                  (credential) => credential.workspaceId === workspace.id
                )!.id,
                fieldMappings: [
                  { columnId: table.columnId, propertyName: 'company' },
                ],
                name: 'RLS HubSpot writeback',
                recordIdColumnId: table.columnId,
                tableId: table.tableId,
                workspaceId: workspace.id,
              };
            })
          )
          .returning({
            id: writebackDestinations.id,
            tableId: writebackDestinations.tableId,
            workspaceId: writebackDestinations.workspaceId,
          });
        await admin.db.insert(writebackDeliveries).values(
          writebackDestinationFixtures.map((destination) => {
            const id = crypto.randomUUID();
            const rowId = sourceRowFixtures.find(
              (row) => row.workspaceId === destination.workspaceId
            )!.id;
            return {
              destinationId: destination.id,
              id,
              payload: {
                adapterId: 'hubspot_contact' as const,
                deliveryId: id,
                occurredAt: new Date().toISOString(),
                properties: { company: 'RLS fixture' },
                recordId: '12345',
                row: { id: rowId, version: 1 },
                tableId: destination.tableId,
                version: 1 as const,
                workspaceId: destination.workspaceId,
              },
              rowId,
              rowVersion: 1,
              tableId: destination.tableId,
              workspaceId: destination.workspaceId,
            };
          })
        );
        await admin.db.insert(rowSettlements).values(
          sourceRowFixtures.map((row) => ({
            rowId: row.id,
            rowVersion: 1,
            tableId: row.tableId,
            workspaceId: row.workspaceId,
          }))
        );

        const visibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) => listUserWorkspaces(scopedDb, ownerA!.id)
        );
        expect(visibleToOwnerA.map((workspace) => workspace.id)).toEqual([
          workspaceA.id,
        ]);
        const batchesVisibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            scopedDb.select({ id: bulkRunBatches.id }).from(bulkRunBatches)
        );
        expect(batchesVisibleToOwnerA).toEqual([
          {
            id: batchFixtures.find(
              (batch) => batch.workspaceId === workspaceA.id
            )!.id,
          },
        ]);
        const sourcesVisibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            scopedDb
              .select({ id: sourceDefinitions.id })
              .from(sourceDefinitions)
        );
        expect(sourcesVisibleToOwnerA).toEqual([
          {
            id: sourceFixtures.find(
              (source) => source.workspaceId === workspaceA.id
            )!.id,
          },
        ]);
        const sourceRunsVisibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) => scopedDb.select({ id: sourceRuns.id }).from(sourceRuns)
        );
        expect(sourceRunsVisibleToOwnerA).toHaveLength(1);
        const sourceRecordsVisibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            scopedDb.select({ rowId: sourceRecords.rowId }).from(sourceRecords)
        );
        expect(sourceRecordsVisibleToOwnerA).toHaveLength(1);
        const webhooksVisibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          async (scopedDb) => ({
            deliveries: await scopedDb
              .select({ id: webhookDeliveries.id })
              .from(webhookDeliveries),
            destinations: await scopedDb
              .select({ id: webhookDestinations.id })
              .from(webhookDestinations),
          })
        );
        expect(webhooksVisibleToOwnerA.destinations).toHaveLength(1);
        expect(webhooksVisibleToOwnerA.deliveries).toHaveLength(1);
        const writebacksVisibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          async (scopedDb) => ({
            deliveries: await scopedDb
              .select({ id: writebackDeliveries.id })
              .from(writebackDeliveries),
            destinations: await scopedDb
              .select({ id: writebackDestinations.id })
              .from(writebackDestinations),
          })
        );
        expect(writebacksVisibleToOwnerA.destinations).toHaveLength(1);
        expect(writebacksVisibleToOwnerA.deliveries).toHaveLength(1);
        const settlementsVisibleToOwnerA = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            scopedDb.select({ id: rowSettlements.id }).from(rowSettlements)
        );
        expect(settlementsVisibleToOwnerA).toHaveLength(1);
        const sourceFixtureA = sourceFixtures.find(
          (source) => source.workspaceId === workspaceA.id
        )!;
        const pausedSource = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            setSourceStatus(scopedDb, {
              sourceId: sourceFixtureA.id,
              status: 'paused',
              tableId: sourceFixtureA.tableId,
              userId: ownerA!.id,
              workspaceId: workspaceA.id,
            })
        );
        expect(pausedSource.status).toBe('paused');
        const rlsImport = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            createCsvImportJob(scopedDb, {
              filename: 'rls.csv',
              headers: ['Company'],
              tableId: sourceFixtureA.tableId,
              userId: ownerA!.id,
              workspaceId: workspaceA.id,
            })
        );
        await withAuthenticatedDatabase(web.db, ownerA!.id, (scopedDb) =>
          stageCsvImportRows(scopedDb, {
            importJobId: rlsImport.id,
            rows: [{ rowNumber: 1, values: ['RLS Company'] }],
            uploadedBytes: 24,
            userId: ownerA!.id,
            workspaceId: workspaceA.id,
          })
        );
        const queuedRlsImport = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            queueCsvImport(scopedDb, {
              importJobId: rlsImport.id,
              userId: ownerA!.id,
              workspaceId: workspaceA.id,
            })
        );
        expect(queuedRlsImport.status).toBe('queued');

        await expect(
          withAuthenticatedDatabase(web.db, ownerA!.id, (scopedDb) =>
            scopedDb.insert(dataTables).values({
              name: 'Cross-tenant write',
              workspaceId: workspaceB.id,
            })
          )
        ).rejects.toThrow();

        const invitation = await withAuthenticatedDatabase(
          web.db,
          ownerA!.id,
          (scopedDb) =>
            createWorkspaceInvitation(scopedDb, {
              email: invitee!.email,
              role: 'member',
              userId: ownerA!.id,
              workspaceId: workspaceA.id,
            })
        );
        const accepted = await withAuthenticatedDatabase(
          web.db,
          invitee!.id,
          (scopedDb) =>
            acceptWorkspaceInvitation(scopedDb, {
              email: invitee!.email,
              token: invitation.token,
              userId: invitee!.id,
            })
        );
        expect(accepted).toMatchObject({
          id: workspaceA.id,
          role: 'member',
        });

        const memberUpdate = await withAuthenticatedDatabase(
          web.db,
          invitee!.id,
          (scopedDb) =>
            scopedDb
              .update(workspaces)
              .set({ name: 'Member must not rename this' })
              .where(eq(workspaces.id, workspaceA.id))
              .returning({ id: workspaces.id })
        );
        expect(memberUpdate).toEqual([]);

        // The identity setting was SET LOCAL, so pooled connections expose no
        // tenant rows once the authenticated transaction has committed.
        expect(
          await web.db.select({ id: workspaces.id }).from(workspaces)
        ).toEqual([]);
        expect(
          await web.db.select({ id: bulkRunBatches.id }).from(bulkRunBatches)
        ).toEqual([]);
        expect(
          await web.db
            .select({ id: sourceDefinitions.id })
            .from(sourceDefinitions)
        ).toEqual([]);
        expect(
          await web.db.select({ id: sourceRuns.id }).from(sourceRuns)
        ).toEqual([]);
        expect(
          await web.db
            .select({ rowId: sourceRecords.rowId })
            .from(sourceRecords)
        ).toEqual([]);
        expect(
          await web.db
            .select({ id: webhookDestinations.id })
            .from(webhookDestinations)
        ).toEqual([]);
        expect(
          await web.db
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
        ).toEqual([]);
        expect(
          await web.db
            .select({ id: writebackDestinations.id })
            .from(writebackDestinations)
        ).toEqual([]);
        expect(
          await web.db
            .select({ id: writebackDeliveries.id })
            .from(writebackDeliveries)
        ).toEqual([]);
        expect(
          await web.db.select({ id: rowSettlements.id }).from(rowSettlements)
        ).toEqual([]);

        const workerVisible = await worker.db
          .select({ id: workspaces.id })
          .from(workspaces)
          .where(inArray(workspaces.id, workspaceIds));
        expect(new Set(workerVisible.map((workspace) => workspace.id))).toEqual(
          new Set(workspaceIds)
        );
        const workerVisibleBatches = await worker.db
          .select({ id: bulkRunBatches.id })
          .from(bulkRunBatches)
          .where(inArray(bulkRunBatches.workspaceId, workspaceIds));
        expect(workerVisibleBatches).toHaveLength(2);
        const workerVisibleSources = await worker.db
          .select({ id: sourceDefinitions.id })
          .from(sourceDefinitions)
          .where(inArray(sourceDefinitions.workspaceId, workspaceIds));
        expect(workerVisibleSources).toHaveLength(2);
        expect(
          await worker.db
            .select({ id: sourceRuns.id })
            .from(sourceRuns)
            .where(inArray(sourceRuns.workspaceId, workspaceIds))
        ).toHaveLength(2);
        expect(
          await worker.db
            .select({ id: webhookDestinations.id })
            .from(webhookDestinations)
            .where(inArray(webhookDestinations.workspaceId, workspaceIds))
        ).toHaveLength(2);
        expect(
          await worker.db
            .select({ id: webhookDeliveries.id })
            .from(webhookDeliveries)
            .where(inArray(webhookDeliveries.workspaceId, workspaceIds))
        ).toHaveLength(2);
        expect(
          await worker.db
            .select({ id: writebackDestinations.id })
            .from(writebackDestinations)
            .where(inArray(writebackDestinations.workspaceId, workspaceIds))
        ).toHaveLength(2);
        expect(
          await worker.db
            .select({ id: writebackDeliveries.id })
            .from(writebackDeliveries)
            .where(inArray(writebackDeliveries.workspaceId, workspaceIds))
        ).toHaveLength(2);
        expect(
          await worker.db
            .select({ id: rowSettlements.id })
            .from(rowSettlements)
            .where(inArray(rowSettlements.workspaceId, workspaceIds))
        ).toHaveLength(2);
        expect(
          await worker.db
            .select({ rowId: sourceRecords.rowId })
            .from(sourceRecords)
            .where(inArray(sourceRecords.workspaceId, workspaceIds))
        ).toHaveLength(2);
      } finally {
        if (workspaceIds.length > 0) {
          await admin.db
            .delete(workspaces)
            .where(inArray(workspaces.id, workspaceIds));
        }
        if (userIds.length > 0) {
          await admin.db.delete(users).where(inArray(users.id, userIds));
        }
        await Promise.all([
          admin.client.end(),
          web.client.end(),
          worker.client.end(),
        ]);
      }
    });
  }
);
