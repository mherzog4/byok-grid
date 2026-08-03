import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { getSqliteGridSnapshot, listSqliteWorkspaceTables } from './grid';
import {
  applySqliteCsvImportBatch,
  createSqliteCsvImportJob,
  failSqliteCsvImportUpload,
  listSqliteCsvImports,
  prepareSqliteCsvImport,
  queueSqliteCsvImport,
  SqliteCsvImportAccessError,
  SqliteCsvImportValidationError,
  stageSqliteCsvImportRows,
} from './imports';
import { migrateSqliteDatabase } from './migrate';
import {
  columns,
  importJobs,
  importStagedRows,
  outboxEvents,
  users,
} from './schema';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const ownerId = 'import-owner';
const outsiderId = 'import-outsider';

describe('SQLite durable CSV imports', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let tableId: string;
  let workspaceId: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-import-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values([
      {
        email: 'import-owner@example.test',
        id: ownerId,
        name: 'Import Owner',
      },
      {
        email: 'import-outsider@example.test',
        id: outsiderId,
        name: 'Import Outsider',
      },
    ]);
    workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: ownerId,
        name: 'Import Owner',
      })
    ).id;
    tableId = (
      await listSqliteWorkspaceTables(handle.db, {
        userId: ownerId,
        workspaceId,
      })
    )[0]!.id;
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('maps headers and resumes committed batches without duplicating rows', async () => {
    const [company] = await handle.db
      .select({ id: columns.id })
      .from(columns)
      .where(
        and(
          eq(columns.tableId, tableId),
          eq(columns.workspaceId, workspaceId),
          eq(columns.name, 'Company')
        )
      );
    const job = await createSqliteCsvImportJob(handle.db, {
      filename: '  companies.csv  ',
      headers: ['company', 'Country'],
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(job.filename).toBe('companies.csv');
    await stageSqliteCsvImportRows(handle.db, {
      importJobId: job.id,
      rows: [
        { rowNumber: 1, values: ['Acme', 'US'] },
        { rowNumber: 2, values: ['Globex', 'GB'] },
        { rowNumber: 3, values: ['Initech', 'CA'] },
      ],
      uploadedBytes: 128,
      userId: ownerId,
      workspaceId,
    });
    await expect(
      stageSqliteCsvImportRows(handle.db, {
        importJobId: job.id,
        rows: [{ rowNumber: 3, values: ['Duplicate', 'US'] }],
        uploadedBytes: 140,
        userId: ownerId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCsvImportValidationError);

    const queued = await queueSqliteCsvImport(handle.db, {
      importJobId: job.id,
      userId: ownerId,
      workspaceId,
    });
    expect(queued).toMatchObject({ stagedRowCount: 3, status: 'queued' });
    await expect(
      createSqliteCsvImportJob(handle.db, {
        filename: 'stolen.csv',
        headers: ['Company'],
        tableId,
        userId: outsiderId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteCsvImportAccessError);

    expect(
      await prepareSqliteCsvImport(handle.db, {
        importJobId: job.id,
        tableId,
        workspaceId,
      })
    ).toBe('ready');
    expect(
      await applySqliteCsvImportBatch(
        handle.db,
        { importJobId: job.id, tableId, workspaceId },
        1
      )
    ).toEqual({ done: false, importedRowCount: 1 });

    expect(
      await prepareSqliteCsvImport(handle.db, {
        importJobId: job.id,
        tableId,
        workspaceId,
      })
    ).toBe('ready');
    expect(
      await applySqliteCsvImportBatch(
        handle.db,
        { importJobId: job.id, tableId, workspaceId },
        2
      )
    ).toEqual({ done: false, importedRowCount: 3 });
    expect(
      await applySqliteCsvImportBatch(handle.db, {
        importJobId: job.id,
        tableId,
        workspaceId,
      })
    ).toEqual({ done: true, importedRowCount: 3 });

    const [completed] = await handle.db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job.id));
    expect(completed).toMatchObject({
      columnMapping: [
        { columnId: company!.id, header: 'company' },
        expect.objectContaining({ header: 'Country' }),
      ],
      importedRowCount: 3,
      stagedRowCount: 3,
      status: 'succeeded',
    });
    expect(
      await handle.db
        .select()
        .from(importStagedRows)
        .where(eq(importStagedRows.importJobId, job.id))
    ).toEqual([]);

    const events = await handle.db
      .select({ eventType: outboxEvents.eventType })
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, job.id));
    expect(events.map((event) => event.eventType).sort()).toEqual([
      'table.csv_import_requested',
      'table.csv_import_succeeded',
    ]);
    const snapshot = await getSqliteGridSnapshot(handle.db, {
      tableId,
      userId: ownerId,
      workspaceId,
    });
    expect(snapshot.rows).toHaveLength(3);
    expect(snapshot.rows.map((row) => row.version)).toEqual([2, 2, 2]);
    expect(snapshot.rows.map((row) => row.cells[company!.id]?.value)).toEqual([
      { type: 'text', value: 'Acme' },
      { type: 'text', value: 'Globex' },
      { type: 'text', value: 'Initech' },
    ]);
    expect(
      await listSqliteCsvImports(handle.db, {
        tableId,
        userId: ownerId,
        workspaceId,
      })
    ).toEqual([expect.objectContaining({ id: job.id, status: 'succeeded' })]);
  });

  it('cleans staged rows and sanitizes an upload failure', async () => {
    const job = await createSqliteCsvImportJob(handle.db, {
      filename: 'malformed.csv',
      headers: ['Company'],
      tableId,
      userId: ownerId,
      workspaceId,
    });
    await stageSqliteCsvImportRows(handle.db, {
      importJobId: job.id,
      rows: [{ rowNumber: 1, values: ['Temporary'] }],
      uploadedBytes: 20,
      userId: ownerId,
      workspaceId,
    });
    await failSqliteCsvImportUpload(handle.db, {
      errorMessage: `Malformed\nrow\t${'x'.repeat(600)}`,
      importJobId: job.id,
      userId: ownerId,
      workspaceId,
    });

    const [failed] = await handle.db
      .select()
      .from(importJobs)
      .where(eq(importJobs.id, job.id));
    expect(failed).toMatchObject({ status: 'failed' });
    expect(failed!.errorMessage).not.toMatch(/[\r\n\t]/);
    expect(failed!.errorMessage).toHaveLength(500);
    expect(
      await handle.db
        .select()
        .from(importStagedRows)
        .where(eq(importStagedRows.importJobId, job.id))
    ).toEqual([]);
  });
});
