import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase, withAuthenticatedDatabase } from './client';
import {
  applyIngestionBatchChunk,
  columns,
  createFormulaColumn,
  createIngestionEndpoint,
  ensurePersonalWorkspace,
  getGridSnapshot,
  getIngestionEndpointCapability,
  hashIngestionToken,
  ingestionEndpoints,
  listIngestionEndpoints,
  listWorkspaceTables,
  markIngestionBatchRunning,
  revokeIngestionEndpoint,
  stageIngestionBatch,
  users,
  workspaces,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const rlsDatabaseUrl = process.env.RLS_DATABASE_URL;

describe.skipIf(!testDatabaseUrl || !rlsDatabaseUrl)(
  'durable push ingestion',
  () => {
    it('authenticates, deduplicates, upserts, recomputes, and revokes', async () => {
      const admin = createDatabase(testDatabaseUrl!);
      const web = createDatabase(rlsDatabaseUrl!);
      let userId: string | undefined;
      let workspaceId: string | undefined;
      try {
        const [owner] = await admin.db
          .insert(users)
          .values({
            email: `ingestion-${crypto.randomUUID()}@example.test`,
            name: 'Ingestion Owner',
          })
          .returning({ id: users.id, name: users.name });
        userId = owner!.id;
        const workspace = await ensurePersonalWorkspace(admin.db, owner!);
        workspaceId = workspace.id;
        const [table] = await listWorkspaceTables(admin.db, {
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        const [companyColumn] = await admin.db
          .select({ id: columns.id })
          .from(columns)
          .where(
            and(
              eq(columns.tableId, table!.id),
              eq(columns.workspaceId, workspace.id),
              eq(columns.name, 'Company')
            )
          );
        const upperColumn = await createFormulaColumn(admin.db, {
          expression: {
            args: [{ columnId: companyColumn!.id, type: 'column' }],
            function: 'upper',
            type: 'call',
          },
          name: 'Company upper',
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });

        const endpoint = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (db) =>
            createIngestionEndpoint(db, {
              name: 'Airbyte companies',
              recordKeyField: 'id',
              tableId: table!.id,
              userId: owner!.id,
              workspaceId: workspace.id,
            })
        );
        expect(endpoint.token).toMatch(/^bg_ingest_/);
        const [storedEndpoint] = await admin.db
          .select()
          .from(ingestionEndpoints)
          .where(eq(ingestionEndpoints.id, endpoint.id));
        expect(JSON.stringify(storedEndpoint)).not.toContain(endpoint.token);
        expect(
          await getIngestionEndpointCapability(web.db, {
            endpointId: endpoint.id,
            tokenHash: hashIngestionToken(endpoint.token),
          })
        ).toEqual({
          endpointId: endpoint.id,
          recordKeyField: 'id',
        });

        const firstBatch = {
          fields: ['id', 'Company'],
          records: [
            { key: 'one', values: { Company: 'Acme', id: 'one' } },
            { key: 'two', values: { Company: 'Globex', id: 'two' } },
          ],
        };
        const first = await stageIngestionBatch(web.db, {
          batch: firstBatch,
          endpointId: endpoint.id,
          idempotencyKey: 'airbyte-job-0001',
          requestDigest: 'a'.repeat(64),
          tokenHash: hashIngestionToken(endpoint.token),
        });
        expect(first).toMatchObject({ recordCount: 2, replayed: false });
        expect(
          await stageIngestionBatch(web.db, {
            batch: firstBatch,
            endpointId: endpoint.id,
            idempotencyKey: 'airbyte-job-0001',
            requestDigest: 'a'.repeat(64),
            tokenHash: hashIngestionToken(endpoint.token),
          })
        ).toMatchObject({ id: first.id, replayed: true });
        await expect(
          stageIngestionBatch(web.db, {
            batch: firstBatch,
            endpointId: endpoint.id,
            idempotencyKey: 'airbyte-job-0001',
            requestDigest: 'b'.repeat(64),
            tokenHash: hashIngestionToken(endpoint.token),
          })
        ).rejects.toThrow(/different request body/i);

        const firstInput = {
          batchId: first.id,
          endpointId: endpoint.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        };
        const ordered = await stageIngestionBatch(web.db, {
          batch: {
            fields: ['id', 'Company'],
            records: [{ key: 'two', values: { Company: 'Globex', id: 'two' } }],
          },
          endpointId: endpoint.id,
          idempotencyKey: 'airbyte-job-0001-followup',
          requestDigest: 'e'.repeat(64),
          tokenHash: hashIngestionToken(endpoint.token),
        });
        const orderedInput = {
          batchId: ordered.id,
          endpointId: endpoint.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        };
        expect(await markIngestionBatchRunning(admin.db, orderedInput)).toBe(
          'waiting'
        );
        expect(await markIngestionBatchRunning(admin.db, firstInput)).toBe(
          'ready'
        );
        expect(
          await applyIngestionBatchChunk(admin.db, firstInput, 1)
        ).toMatchObject({ done: false });
        expect(
          await applyIngestionBatchChunk(admin.db, firstInput, 1)
        ).toMatchObject({ done: false });
        expect(await applyIngestionBatchChunk(admin.db, firstInput, 1)).toEqual(
          expect.objectContaining({
            done: true,
            summary: expect.objectContaining({
              createdRowCount: 2,
              status: 'succeeded',
            }),
          })
        );
        expect(await markIngestionBatchRunning(admin.db, orderedInput)).toBe(
          'ready'
        );
        await applyIngestionBatchChunk(admin.db, orderedInput);
        expect(
          (await applyIngestionBatchChunk(admin.db, orderedInput)).summary
            .status
        ).toBe('succeeded');

        const second = await stageIngestionBatch(web.db, {
          batch: {
            fields: ['id', 'Company', 'Country'],
            records: [
              {
                key: 'one',
                values: { Company: 'Acme Inc', Country: 'US', id: 'one' },
              },
              {
                key: 'three',
                values: { Company: 'Initech', Country: 'CA', id: 'three' },
              },
            ],
          },
          endpointId: endpoint.id,
          idempotencyKey: 'airbyte-job-0002',
          requestDigest: 'c'.repeat(64),
          tokenHash: hashIngestionToken(endpoint.token),
        });
        const secondInput = {
          batchId: second.id,
          endpointId: endpoint.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        };
        await markIngestionBatchRunning(admin.db, secondInput);
        await applyIngestionBatchChunk(admin.db, secondInput);
        const secondResult = await applyIngestionBatchChunk(
          admin.db,
          secondInput
        );
        expect(secondResult.summary).toMatchObject({
          createdRowCount: 1,
          status: 'succeeded',
          updatedRowCount: 1,
        });

        const snapshot = await getGridSnapshot(admin.db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        expect(snapshot.rows).toHaveLength(3);
        const companyUpperValues = snapshot.rows
          .flatMap((row) => {
            const value = row.cells[upperColumn.id]?.value;
            return value?.type === 'text' ? [value.value] : [];
          })
          .sort();
        expect(companyUpperValues).toEqual(['ACME INC', 'GLOBEX', 'INITECH']);

        const patchBatch = await stageIngestionBatch(web.db, {
          batch: {
            fields: ['id'],
            records: [{ key: 'one', values: { id: 'one' } }],
          },
          endpointId: endpoint.id,
          idempotencyKey: 'airbyte-job-0003',
          requestDigest: 'f'.repeat(64),
          tokenHash: hashIngestionToken(endpoint.token),
        });
        const patchInput = {
          batchId: patchBatch.id,
          endpointId: endpoint.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        };
        await markIngestionBatchRunning(admin.db, patchInput);
        await applyIngestionBatchChunk(admin.db, patchInput);
        await applyIngestionBatchChunk(admin.db, patchInput);
        const patchedSnapshot = await getGridSnapshot(admin.db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        expect(
          patchedSnapshot.rows
            .flatMap((row) => {
              const value = row.cells[upperColumn.id]?.value;
              return value?.type === 'text' ? [value.value] : [];
            })
            .sort()
        ).toEqual(['ACME INC', 'GLOBEX', 'INITECH']);

        const listed = await withAuthenticatedDatabase(
          web.db,
          owner!.id,
          (db) =>
            listIngestionEndpoints(db, {
              tableId: table!.id,
              userId: owner!.id,
              workspaceId: workspace.id,
            })
        );
        expect(listed[0]?.lastBatch).toMatchObject({ status: 'succeeded' });
        await withAuthenticatedDatabase(web.db, owner!.id, (db) =>
          revokeIngestionEndpoint(db, {
            endpointId: endpoint.id,
            tableId: table!.id,
            userId: owner!.id,
            workspaceId: workspace.id,
          })
        );
        await expect(
          stageIngestionBatch(web.db, {
            batch: firstBatch,
            endpointId: endpoint.id,
            idempotencyKey: 'airbyte-job-0004',
            requestDigest: 'd'.repeat(64),
            tokenHash: hashIngestionToken(endpoint.token),
          })
        ).rejects.toThrow(/invalid/i);
        await expect(
          getIngestionEndpointCapability(web.db, {
            endpointId: endpoint.id,
            tokenHash: hashIngestionToken(endpoint.token),
          })
        ).rejects.toThrow(/not accessible/i);
      } finally {
        if (workspaceId) {
          await admin.db
            .delete(workspaces)
            .where(eq(workspaces.id, workspaceId));
        }
        if (userId) await admin.db.delete(users).where(eq(users.id, userId));
        await Promise.all([admin.client.end(), web.client.end()]);
      }
    });
  }
);
