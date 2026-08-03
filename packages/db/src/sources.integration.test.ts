import { and, eq, inArray } from 'drizzle-orm';
import {
  encryptSourceCursor,
  parseMasterKey,
  unwrapWorkspaceKey,
} from '@byok-grid/security';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  applySourceRunBatch,
  applySourceRunPage,
  columns,
  createFormulaColumn,
  createEncryptedCredential,
  createHttpJsonSource,
  createHubSpotContactsSource,
  ensurePersonalWorkspace,
  getGridSnapshot,
  listSources,
  listWorkspaceTables,
  markSourceRunRunning,
  outboxEvents,
  queueDueSourceRuns,
  queueManualSourceRun,
  setSourceStatus,
  SourceAccessError,
  SourceConflictError,
  sourceDefinitions,
  sourceRecords,
  sourceRuns,
  users,
  workspaceKeys,
  workspaces,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('durable scheduled sources', () => {
  it('schedules, upserts, preserves missing records, and isolates tenants', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const masterKey = parseMasterKey(
      'source-test-v1',
      randomBytes(32).toString('base64')
    );

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `source-owner-${crypto.randomUUID()}@example.test`,
            name: 'Source Owner',
          },
          {
            email: `source-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Source Outsider',
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
      const companyUpper = await createFormulaColumn(db, {
        expression: {
          args: [{ columnId: company!.id, type: 'column' }],
          function: 'upper',
          type: 'call',
        },
        name: 'Company upper',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });

      const credential = await createEncryptedCredential(db, {
        connectorId: 'http',
        masterKey,
        name: 'Source HTTP token',
        secret: {
          token: 'source-test-secret-must-not-enter-workflows',
          type: 'bearer',
        },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const source = await createHttpJsonSource(db, {
        credentialId: credential.id,
        maxRecords: 100,
        name: 'CRM companies',
        pagination: { mode: 'none' },
        recordKeyField: 'id',
        recordPath: 'data.companies',
        schedule: 'hourly',
        tableId: table!.id,
        url: 'https://api.example.com/companies',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(source).toMatchObject({
        name: 'CRM companies',
        scheduleIntervalMinutes: 60,
        status: 'active',
      });
      await expect(
        createHttpJsonSource(db, {
          credentialId: null,
          maxRecords: 100,
          name: 'Stolen source',
          pagination: { mode: 'none' },
          recordKeyField: 'id',
          recordPath: '',
          schedule: 'manual',
          tableId: table!.id,
          url: 'https://api.example.com/companies',
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(SourceAccessError);

      const dueAt = new Date('2026-01-01T00:00:00Z');
      await db
        .update(sourceDefinitions)
        .set({ nextRunAt: dueAt })
        .where(eq(sourceDefinitions.id, source.id));
      expect(
        await queueDueSourceRuns(db, new Date('2026-01-01T00:01:00Z'))
      ).toBe(1);
      expect(
        await queueDueSourceRuns(db, new Date('2026-01-01T00:01:00Z'))
      ).toBe(0);
      const [requested] = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateType, 'source_run'),
            eq(outboxEvents.eventType, 'table.source_run_requested'),
            eq(outboxEvents.workspaceId, workspace.id)
          )
        );
      expect(requested).toBeDefined();
      expect(JSON.stringify({ requested, source })).not.toContain(
        'source-test-secret-must-not-enter-workflows'
      );
      const firstInput = requested!.payload as {
        sourceId: string;
        sourceRunId: string;
        tableId: string;
        workspaceId: string;
      };
      expect(await markSourceRunRunning(db, firstInput)).toBe('ready');
      const firstResult = await applySourceRunBatch(db, {
        ...firstInput,
        batch: {
          fields: ['id', 'Company'],
          records: [
            { key: 'one', values: { Company: 'Acme', id: 'one' } },
            { key: 'two', values: { Company: 'Globex', id: 'two' } },
          ],
        },
      });
      expect(firstResult).toMatchObject({
        createdRowCount: 2,
        receivedRecordCount: 2,
        status: 'succeeded',
        updatedRowCount: 0,
      });
      expect(await markSourceRunRunning(db, firstInput)).toBe('succeeded');

      const secondRun = await queueManualSourceRun(db, {
        sourceId: source.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const secondInput = {
        sourceId: source.id,
        sourceRunId: secondRun.id,
        tableId: table!.id,
        workspaceId: workspace.id,
      };
      expect(await markSourceRunRunning(db, secondInput)).toBe('ready');
      const secondResult = await applySourceRunBatch(db, {
        ...secondInput,
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
      });
      expect(secondResult).toMatchObject({
        createdRowCount: 1,
        receivedRecordCount: 2,
        status: 'succeeded',
        updatedRowCount: 1,
      });

      const identities = await db
        .select()
        .from(sourceRecords)
        .where(eq(sourceRecords.sourceId, source.id));
      expect(identities.map((item) => item.recordKey).sort()).toEqual([
        'one',
        'three',
        'two',
      ]);
      const snapshot = await getGridSnapshot(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(snapshot.rows).toHaveLength(3);
      const rowIdByKey = new Map(
        identities.map((identity) => [identity.recordKey, identity.rowId])
      );
      const rowOne = snapshot.rows.find(
        (row) => row.id === rowIdByKey.get('one')
      );
      const rowTwo = snapshot.rows.find(
        (row) => row.id === rowIdByKey.get('two')
      );
      expect(rowOne?.cells[companyUpper.id]?.value).toEqual({
        type: 'text',
        value: 'ACME INC',
      });
      expect(rowTwo?.cells[companyUpper.id]?.value).toEqual({
        type: 'text',
        value: 'GLOBEX',
      });

      const listed = await listSources(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(listed[0]?.lastRun).toMatchObject({
        createdRowCount: 1,
        status: 'succeeded',
        updatedRowCount: 1,
      });

      const paginatedSource = await createHttpJsonSource(db, {
        credentialId: null,
        maxRecords: 10,
        missingRecordMode: 'archive',
        name: 'Cursor CRM companies',
        pagination: {
          cursorParameter: 'after',
          maxPages: 3,
          mode: 'cursor',
          nextCursorPath: 'meta.next',
        },
        recordKeyField: 'id',
        recordPath: 'data.companies',
        schedule: 'manual',
        tableId: table!.id,
        url: 'https://api.example.com/cursor-companies',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const paginatedRun = await queueManualSourceRun(db, {
        sourceId: paginatedSource.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const paginatedInput = {
        sourceId: paginatedSource.id,
        sourceRunId: paginatedRun.id,
        tableId: table!.id,
        workspaceId: workspace.id,
      };
      expect(await markSourceRunRunning(db, paginatedInput)).toBe('ready');
      const [storedKey] = await db
        .select()
        .from(workspaceKeys)
        .where(eq(workspaceKeys.workspaceId, workspace.id));
      const workspaceKey = unwrapWorkspaceKey(
        workspace.id,
        storedKey!.wrappedKey,
        masterKey
      );
      try {
        const pageTwoCursor = encryptSourceCursor(
          workspace.id,
          paginatedRun.id,
          workspaceKey,
          'remote-page-two-token'
        );
        const firstPage = await applySourceRunPage(db, {
          ...paginatedInput,
          batch: {
            fields: ['id', 'Company'],
            records: [
              {
                key: 'cursor-one',
                values: { Company: 'Umbrella', id: 'cursor-one' },
              },
              {
                key: 'cursor-two',
                values: { Company: 'Soylent', id: 'cursor-two' },
              },
            ],
          },
          expectedPage: 1,
          nextCursorEncrypted: pageTwoCursor,
        });
        expect(firstPage).toMatchObject({
          createdRowCount: 2,
          pageCount: 1,
          receivedRecordCount: 2,
          status: 'running',
        });

        const repeatedPage = await applySourceRunPage(db, {
          ...paginatedInput,
          batch: { fields: [], records: [] },
          expectedPage: 1,
          nextCursorEncrypted: pageTwoCursor,
        });
        expect(repeatedPage).toMatchObject({
          createdRowCount: 2,
          pageCount: 1,
          receivedRecordCount: 2,
        });

        const [checkpoint] = await db
          .select()
          .from(sourceRuns)
          .where(eq(sourceRuns.id, paginatedRun.id));
        expect(JSON.stringify(checkpoint!.nextCursorEncrypted)).not.toContain(
          'remote-page-two-token'
        );

        const finalPage = await applySourceRunPage(db, {
          ...paginatedInput,
          batch: {
            fields: ['id', 'Company'],
            records: [
              {
                key: 'cursor-three',
                values: { Company: 'Hooli', id: 'cursor-three' },
              },
            ],
          },
          expectedPage: 2,
          nextCursorEncrypted: null,
        });
        expect(finalPage).toMatchObject({
          archivedRowCount: 0,
          createdRowCount: 3,
          pageCount: 2,
          receivedRecordCount: 3,
          status: 'succeeded',
          updatedRowCount: 0,
        });

        const firstSnapshotIdentities = await db
          .select()
          .from(sourceRecords)
          .where(eq(sourceRecords.sourceId, paginatedSource.id));
        const cursorTwoRowId = firstSnapshotIdentities.find(
          (identity) => identity.recordKey === 'cursor-two'
        )!.rowId;

        const omissionRun = await queueManualSourceRun(db, {
          sourceId: paginatedSource.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        const omissionInput = {
          sourceId: paginatedSource.id,
          sourceRunId: omissionRun.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        };
        expect(await markSourceRunRunning(db, omissionInput)).toBe('ready');
        const omissionCursor = encryptSourceCursor(
          workspace.id,
          omissionRun.id,
          workspaceKey,
          'omission-page-two'
        );
        const incompleteSnapshot = await applySourceRunPage(db, {
          ...omissionInput,
          batch: {
            fields: ['id', 'Company'],
            records: [
              {
                key: 'cursor-one',
                values: { Company: 'Umbrella Corp', id: 'cursor-one' },
              },
            ],
          },
          expectedPage: 1,
          nextCursorEncrypted: omissionCursor,
        });
        expect(incompleteSnapshot).toMatchObject({
          archivedRowCount: 0,
          status: 'running',
        });
        expect(
          (
            await getGridSnapshot(db, {
              tableId: table!.id,
              userId: owner!.id,
              workspaceId: workspace.id,
            })
          ).rows.some((row) => row.id === cursorTwoRowId)
        ).toBe(true);

        const reconciledSnapshot = await applySourceRunPage(db, {
          ...omissionInput,
          batch: { fields: [], records: [] },
          expectedPage: 2,
          nextCursorEncrypted: null,
        });
        expect(reconciledSnapshot).toMatchObject({
          archivedRowCount: 2,
          status: 'succeeded',
        });
        expect(
          (
            await getGridSnapshot(db, {
              tableId: table!.id,
              userId: owner!.id,
              workspaceId: workspace.id,
            })
          ).rows.some((row) => row.id === cursorTwoRowId)
        ).toBe(false);

        const reappearanceRun = await queueManualSourceRun(db, {
          sourceId: paginatedSource.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        const reappearanceInput = {
          sourceId: paginatedSource.id,
          sourceRunId: reappearanceRun.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        };
        expect(await markSourceRunRunning(db, reappearanceInput)).toBe('ready');
        const restoredSnapshot = await applySourceRunBatch(db, {
          ...reappearanceInput,
          batch: {
            fields: ['id', 'Company'],
            records: [
              {
                key: 'cursor-one',
                values: { Company: 'Umbrella Corp', id: 'cursor-one' },
              },
              {
                key: 'cursor-two',
                values: { Company: 'Soylent Green', id: 'cursor-two' },
              },
            ],
          },
        });
        expect(restoredSnapshot).toMatchObject({
          archivedRowCount: 0,
          restoredRowCount: 1,
          status: 'succeeded',
        });
        const restoredIdentity = (
          await db
            .select()
            .from(sourceRecords)
            .where(eq(sourceRecords.sourceId, paginatedSource.id))
        ).find((identity) => identity.recordKey === 'cursor-two');
        expect(restoredIdentity).toMatchObject({
          archivedAt: null,
          archivedByRunId: null,
          rowId: cursorTwoRowId,
        });
        expect(
          (
            await getGridSnapshot(db, {
              tableId: table!.id,
              userId: owner!.id,
              workspaceId: workspace.id,
            })
          ).rows.some((row) => row.id === cursorTwoRowId)
        ).toBe(true);
      } finally {
        workspaceKey.fill(0);
      }

      const paused = await setSourceStatus(db, {
        sourceId: source.id,
        status: 'paused',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(paused).toMatchObject({ nextRunAt: null, status: 'paused' });
      await expect(
        queueManualSourceRun(db, {
          sourceId: source.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(SourceConflictError);
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

  it('freezes and advances a HubSpot incremental watermark only after the last page', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const masterKey = parseMasterKey(
      'hubspot-source-test-v1',
      randomBytes(32).toString('base64')
    );
    let workspaceId: string | undefined;
    let userId: string | undefined;
    try {
      const [owner] = await db
        .insert(users)
        .values({
          email: `hubspot-source-${crypto.randomUUID()}@example.test`,
          name: 'HubSpot Source Owner',
        })
        .returning({ id: users.id, name: users.name });
      userId = owner!.id;
      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceId = workspace.id;
      const [table] = await listWorkspaceTables(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const credential = await createEncryptedCredential(db, {
        connectorId: 'hubspot',
        masterKey,
        name: 'HubSpot source token',
        secret: { accessToken: 'synthetic-hubspot-private-app-token' },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const source = await createHubSpotContactsSource(db, {
        credentialId: credential.id,
        initialSyncFrom: '2026-01-01T00:00:00.000Z',
        maxPages: 10,
        maxRecords: 1_000,
        name: 'Incremental contacts',
        properties: ['email', 'firstname'],
        schedule: 'manual',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(source).toMatchObject({
        adapterId: 'hubspot_contacts',
        hubSpot: {
          initialSyncFrom: '2026-01-01T00:00:00.000Z',
          properties: ['email', 'firstname'],
        },
        incrementalWatermark: null,
        missingRecordMode: 'preserve',
      });
      const run = await queueManualSourceRun(db, {
        sourceId: source.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(run.incrementalWindowStart?.toISOString()).toBe(
        '2026-01-01T00:00:00.000Z'
      );
      expect(run.incrementalWindowEnd).toBeInstanceOf(Date);
      const runInput = {
        sourceId: source.id,
        sourceRunId: run.id,
        tableId: table!.id,
        workspaceId: workspace.id,
      };
      expect(await markSourceRunRunning(db, runInput)).toBe('ready');
      const [storedWorkspaceKey] = await db
        .select()
        .from(workspaceKeys)
        .where(eq(workspaceKeys.workspaceId, workspace.id));
      const workspaceKey = unwrapWorkspaceKey(
        workspace.id,
        storedWorkspaceKey!.wrappedKey,
        masterKey
      );
      try {
        const nextCursorEncrypted = encryptSourceCursor(
          workspace.id,
          run.id,
          workspaceKey,
          'hubspot-page-two'
        );
        await applySourceRunPage(db, {
          ...runInput,
          batch: {
            fields: ['hubspot_contact_id', 'email', 'firstname'],
            records: [
              {
                key: '12345',
                values: {
                  email: 'ada@example.test',
                  firstname: 'Ada',
                  hubspot_contact_id: '12345',
                },
              },
            ],
          },
          expectedPage: 1,
          nextCursorEncrypted,
        });
        const [beforeCompletion] = await db
          .select({ watermark: sourceDefinitions.incrementalWatermark })
          .from(sourceDefinitions)
          .where(eq(sourceDefinitions.id, source.id));
        expect(beforeCompletion?.watermark).toBeNull();
        const completed = await applySourceRunPage(db, {
          ...runInput,
          batch: { fields: [], records: [] },
          expectedPage: 2,
          nextCursorEncrypted: null,
        });
        expect(completed).toMatchObject({
          pageCount: 2,
          receivedRecordCount: 1,
          status: 'succeeded',
        });
        const [afterCompletion] = await db
          .select({ watermark: sourceDefinitions.incrementalWatermark })
          .from(sourceDefinitions)
          .where(eq(sourceDefinitions.id, source.id));
        expect(afterCompletion?.watermark?.toISOString()).toBe(
          run.incrementalWindowEnd?.toISOString()
        );
      } finally {
        workspaceKey.fill(0);
      }
    } finally {
      if (workspaceId) {
        await db.delete(workspaces).where(eq(workspaces.id, workspaceId));
      }
      if (userId) await db.delete(users).where(eq(users.id, userId));
      masterKey.value.fill(0);
      await client.end();
    }
  });
});
