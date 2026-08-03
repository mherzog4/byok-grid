import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  applyCsvImportBatch,
  columns,
  createCsvImportJob,
  createFormulaColumn,
  CsvImportAccessError,
  ensurePersonalWorkspace,
  failCsvImportUpload,
  getGridSnapshot,
  importJobs,
  importStagedRows,
  listWorkspaceTables,
  outboxEvents,
  prepareCsvImport,
  queueCsvImport,
  stageCsvImportRows,
  users,
  workspaces,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('durable CSV imports', () => {
  it('maps headers, resumes batches, recomputes formulas, and isolates tenants', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `import-owner-${crypto.randomUUID()}@example.test`,
            name: 'Import Owner',
          },
          {
            email: `import-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Import Outsider',
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
      const computed = await createFormulaColumn(db, {
        expression: {
          type: 'call',
          function: 'upper',
          args: [{ type: 'column', columnId: company!.id }],
        },
        name: 'Company upper',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });

      const job = await createCsvImportJob(db, {
        filename: 'companies.csv',
        headers: ['company', 'Company upper', 'Country'],
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await stageCsvImportRows(db, {
        importJobId: job.id,
        rows: [
          { rowNumber: 1, values: ['Acme', 'source-one', 'US'] },
          { rowNumber: 2, values: ['Globex', 'source-two', 'GB'] },
          { rowNumber: 3, values: ['Initech', 'source-three', 'CA'] },
        ],
        uploadedBytes: 128,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const queued = await queueCsvImport(db, {
        importJobId: job.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(queued).toMatchObject({ stagedRowCount: 3, status: 'queued' });
      const [requested] = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, job.id));
      expect(requested).toMatchObject({
        eventType: 'table.csv_import_requested',
        publishedAt: null,
      });

      await expect(
        createCsvImportJob(db, {
          filename: 'stolen.csv',
          headers: ['Company'],
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(CsvImportAccessError);

      expect(
        await prepareCsvImport(db, {
          importJobId: job.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        })
      ).toBe('ready');
      expect(
        await applyCsvImportBatch(
          db,
          {
            importJobId: job.id,
            tableId: table!.id,
            workspaceId: workspace.id,
          },
          1
        )
      ).toEqual({ done: false, importedRowCount: 1 });

      // Simulate a worker restart between committed batches.
      expect(
        await prepareCsvImport(db, {
          importJobId: job.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        })
      ).toBe('ready');
      await applyCsvImportBatch(
        db,
        {
          importJobId: job.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        },
        2
      );
      expect(
        await applyCsvImportBatch(db, {
          importJobId: job.id,
          tableId: table!.id,
          workspaceId: workspace.id,
        })
      ).toEqual({ done: true, importedRowCount: 3 });

      const [completed] = await db
        .select()
        .from(importJobs)
        .where(eq(importJobs.id, job.id));
      expect(completed).toMatchObject({
        importedRowCount: 3,
        stagedRowCount: 3,
        status: 'succeeded',
      });
      expect(completed!.columnMapping).toEqual([
        { columnId: company!.id, header: 'company' },
        expect.objectContaining({ header: 'Company upper' }),
        expect.objectContaining({ header: 'Country' }),
      ]);
      const stagedAfterSuccess = await db
        .select()
        .from(importStagedRows)
        .where(eq(importStagedRows.importJobId, job.id));
      expect(stagedAfterSuccess).toHaveLength(0);

      const importedColumn = await db
        .select({ id: columns.id, name: columns.name })
        .from(columns)
        .where(
          and(
            eq(columns.tableId, table!.id),
            eq(columns.workspaceId, workspace.id)
          )
        );
      expect(importedColumn.map(({ name }) => name)).toContain(
        'Company upper (import 2)'
      );
      const snapshot = await getGridSnapshot(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(snapshot.rows).toHaveLength(3);
      expect(snapshot.rows[0]?.cells[computed.id]?.value).toEqual({
        type: 'text',
        value: 'ACME',
      });
      expect(snapshot.rows[2]?.cells[computed.id]?.value).toEqual({
        type: 'text',
        value: 'INITECH',
      });

      const malformed = await createCsvImportJob(db, {
        filename: 'malformed.csv',
        headers: ['Company'],
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await stageCsvImportRows(db, {
        importJobId: malformed.id,
        rows: [{ rowNumber: 1, values: ['Temporary'] }],
        uploadedBytes: 20,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await failCsvImportUpload(db, {
        errorMessage: 'Malformed later row',
        importJobId: malformed.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const failedStaging = await db
        .select()
        .from(importStagedRows)
        .where(eq(importStagedRows.importJobId, malformed.id));
      expect(failedStaging).toHaveLength(0);
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
