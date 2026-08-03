import { CsvImportDefinitionError, planCsvColumns } from '@byok-grid/domain';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { type SqliteDatabase, withSqliteWriteTransaction } from './client';
import { recomputeDependentSqliteFormulasForRow } from './formulas';
import { recordSqliteRowMutationAndMaybeQueueSettlement } from './row-mutations';
import {
  cells,
  columns,
  dataTables,
  importJobs,
  importStagedRows,
  outboxEvents,
  rows,
  workspaceMembers,
  type CsvImportColumnMapping,
} from './schema';

export class SqliteCsvImportAccessError extends Error {}
export class SqliteCsvImportValidationError extends Error {}

interface ImportScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

export interface SqliteCsvImportSummary {
  errorMessage: string | null;
  filename: string;
  id: string;
  importedRowCount: number;
  stagedRowCount: number;
  status: (typeof importJobs.$inferSelect)['status'];
}

export async function assertSqliteCsvImportTableAccess(
  db: Pick<SqliteDatabase, 'select'>,
  scope: ImportScope
): Promise<void> {
  const [table] = await db
    .select({ id: dataTables.id })
    .from(dataTables)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, dataTables.workspaceId),
        eq(workspaceMembers.userId, scope.userId)
      )
    )
    .where(
      and(
        eq(dataTables.id, scope.tableId),
        eq(dataTables.workspaceId, scope.workspaceId),
        isNull(dataTables.archivedAt)
      )
    )
    .limit(1);
  if (!table) {
    throw new SqliteCsvImportAccessError('The table is not accessible.');
  }
}

export async function createSqliteCsvImportJob(
  db: SqliteDatabase,
  input: ImportScope & { filename: string; headers: readonly string[] }
): Promise<SqliteCsvImportSummary> {
  const filename = validateFilename(input.filename);
  if (input.headers.length === 0 || input.headers.length > 256) {
    throw new SqliteCsvImportValidationError(
      'CSV files must contain between 1 and 256 columns.'
    );
  }
  try {
    planCsvColumns(input.headers, []);
  } catch (error) {
    if (error instanceof CsvImportDefinitionError) {
      throw new SqliteCsvImportValidationError(error.message);
    }
    throw error;
  }

  return withSqliteWriteTransaction(db, async (tx) => {
    await assertSqliteCsvImportTableAccess(tx, input);
    const [job] = await tx
      .insert(importJobs)
      .values({
        createdByUserId: input.userId,
        filename,
        headers: [...input.headers],
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      })
      .returning();
    if (!job) throw new Error('The CSV import job could not be created.');
    return toSqliteCsvImportSummary(job);
  });
}

export async function stageSqliteCsvImportRows(
  db: SqliteDatabase,
  input: {
    importJobId: string;
    rows: ReadonlyArray<Readonly<{ rowNumber: number; values: string[] }>>;
    uploadedBytes: number;
    userId: string;
    workspaceId: string;
  }
): Promise<void> {
  if (input.rows.length === 0) return;
  await withSqliteWriteTransaction(db, async (tx) => {
    const [job] = await tx
      .select({
        headers: importJobs.headers,
        id: importJobs.id,
        stagedRowCount: importJobs.stagedRowCount,
      })
      .from(importJobs)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, importJobs.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .where(
        and(
          eq(importJobs.id, input.importJobId),
          eq(importJobs.workspaceId, input.workspaceId),
          eq(importJobs.status, 'staging')
        )
      )
      .limit(1);
    if (!job) {
      throw new SqliteCsvImportAccessError('The import is not accessible.');
    }

    const firstExpectedRow = job.stagedRowCount + 1;
    if (input.rows[0]?.rowNumber !== firstExpectedRow) {
      throw new SqliteCsvImportValidationError(
        'CSV rows must be staged once and in order.'
      );
    }
    for (let index = 0; index < input.rows.length; index += 1) {
      const record = input.rows[index]!;
      if (
        record.rowNumber !== firstExpectedRow + index ||
        record.values.length !== job.headers.length
      ) {
        throw new SqliteCsvImportValidationError(
          `CSV row ${record.rowNumber} does not match the header.`
        );
      }
    }

    await tx.insert(importStagedRows).values(
      input.rows.map((record) => ({
        importJobId: input.importJobId,
        rowNumber: record.rowNumber,
        values: record.values,
        workspaceId: input.workspaceId,
      }))
    );
    await tx
      .update(importJobs)
      .set({
        stagedRowCount: job.stagedRowCount + input.rows.length,
        updatedAt: new Date(),
        uploadedBytes: input.uploadedBytes,
      })
      .where(
        and(
          eq(importJobs.id, input.importJobId),
          eq(importJobs.workspaceId, input.workspaceId),
          eq(importJobs.status, 'staging')
        )
      );
  });
}

export async function queueSqliteCsvImport(
  db: SqliteDatabase,
  input: { importJobId: string; userId: string; workspaceId: string }
): Promise<SqliteCsvImportSummary> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [job] = await tx
      .select({ job: importJobs })
      .from(importJobs)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, importJobs.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .where(
        and(
          eq(importJobs.id, input.importJobId),
          eq(importJobs.workspaceId, input.workspaceId),
          eq(importJobs.status, 'staging')
        )
      )
      .limit(1);
    if (!job) {
      throw new SqliteCsvImportAccessError('The import is not accessible.');
    }
    if (job.job.stagedRowCount === 0) {
      throw new SqliteCsvImportValidationError(
        'The CSV must contain at least one data row.'
      );
    }

    const now = new Date();
    const [queued] = await tx
      .update(importJobs)
      .set({ errorMessage: null, status: 'queued', updatedAt: now })
      .where(
        and(eq(importJobs.id, job.job.id), eq(importJobs.status, 'staging'))
      )
      .returning();
    if (!queued) {
      throw new SqliteCsvImportAccessError('The import is not accessible.');
    }
    await tx.insert(outboxEvents).values({
      aggregateId: queued.id,
      aggregateType: 'import_job',
      eventType: 'table.csv_import_requested',
      payload: {
        importJobId: queued.id,
        tableId: queued.tableId,
        workspaceId: queued.workspaceId,
      },
      workspaceId: queued.workspaceId,
    });
    return toSqliteCsvImportSummary(queued);
  });
}

export async function failSqliteCsvImportUpload(
  db: SqliteDatabase,
  input: {
    errorMessage: string;
    importJobId: string;
    userId: string;
    workspaceId: string;
  }
): Promise<void> {
  await withSqliteWriteTransaction(db, async (tx) => {
    const [failed] = await tx
      .update(importJobs)
      .set({
        errorMessage: safeErrorMessage(input.errorMessage),
        finishedAt: new Date(),
        status: 'failed',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importJobs.id, input.importJobId),
          eq(importJobs.workspaceId, input.workspaceId),
          eq(importJobs.createdByUserId, input.userId),
          eq(importJobs.status, 'staging')
        )
      )
      .returning({ id: importJobs.id });
    if (failed) {
      await tx
        .delete(importStagedRows)
        .where(
          and(
            eq(importStagedRows.importJobId, failed.id),
            eq(importStagedRows.workspaceId, input.workspaceId)
          )
        );
    }
  });
}

export async function listSqliteCsvImports(
  db: SqliteDatabase,
  input: { tableId: string; userId: string; workspaceId: string }
): Promise<SqliteCsvImportSummary[]> {
  return db
    .select({ job: importJobs })
    .from(importJobs)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, importJobs.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(importJobs.tableId, input.tableId),
        eq(importJobs.workspaceId, input.workspaceId)
      )
    )
    .orderBy(desc(importJobs.createdAt), desc(importJobs.id))
    .limit(10)
    .then((records) => records.map(({ job }) => toSqliteCsvImportSummary(job)));
}

export async function prepareSqliteCsvImport(
  db: SqliteDatabase,
  input: { importJobId: string; tableId: string; workspaceId: string }
): Promise<'ready' | 'succeeded' | 'cancelled'> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [job] = await tx
      .select()
      .from(importJobs)
      .where(
        and(
          eq(importJobs.id, input.importJobId),
          eq(importJobs.tableId, input.tableId),
          eq(importJobs.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!job) {
      throw new SqliteCsvImportAccessError('The import job does not exist.');
    }
    if (job.status === 'succeeded') return 'succeeded';
    if (job.status === 'cancelled') return 'cancelled';
    if (job.status !== 'queued' && job.status !== 'running') {
      throw new SqliteCsvImportValidationError(
        `The import cannot run from status ${job.status}.`
      );
    }

    let mapping = job.columnMapping;
    if (!mapping) {
      const existingColumns = await tx
        .select({
          id: columns.id,
          kind: columns.kind,
          name: columns.name,
          valueType: columns.valueType,
        })
        .from(columns)
        .where(
          and(
            eq(columns.tableId, job.tableId),
            eq(columns.workspaceId, job.workspaceId),
            isNull(columns.archivedAt)
          )
        )
        .orderBy(asc(columns.position));
      let plans;
      try {
        plans = planCsvColumns(job.headers, existingColumns);
      } catch (error) {
        if (error instanceof CsvImportDefinitionError) {
          throw new SqliteCsvImportValidationError(error.message);
        }
        throw error;
      }

      const resolved: Array<{ columnId: string; header: string }> = [];
      for (let index = 0; index < plans.length; index += 1) {
        const plan = plans[index]!;
        if (plan.existingColumnId) {
          resolved.push({
            columnId: plan.existingColumnId,
            header: plan.header,
          });
          continue;
        }
        const [created] = await tx
          .insert(columns)
          .values({
            kind: 'input',
            name: plan.columnName,
            position: `x-${job.id}-${String(index).padStart(4, '0')}`,
            tableId: job.tableId,
            valueType: 'text',
            workspaceId: job.workspaceId,
          })
          .returning({ id: columns.id });
        if (!created) throw new Error('An import column could not be created.');
        resolved.push({ columnId: created.id, header: plan.header });
      }
      mapping = resolved satisfies CsvImportColumnMapping;
    }

    await tx
      .update(importJobs)
      .set({
        columnMapping: mapping,
        errorMessage: null,
        startedAt: job.startedAt ?? new Date(),
        status: 'running',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(importJobs.id, job.id),
          inArray(importJobs.status, ['queued', 'running'])
        )
      );
    return 'ready';
  });
}

export async function applySqliteCsvImportBatch(
  db: SqliteDatabase,
  input: { importJobId: string; tableId: string; workspaceId: string },
  batchSize = 250
): Promise<{ done: boolean; importedRowCount: number }> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [job] = await tx
      .select()
      .from(importJobs)
      .where(
        and(
          eq(importJobs.id, input.importJobId),
          eq(importJobs.tableId, input.tableId),
          eq(importJobs.workspaceId, input.workspaceId),
          eq(importJobs.status, 'running')
        )
      )
      .limit(1);
    if (!job) {
      throw new SqliteCsvImportAccessError('The running import was not found.');
    }
    if (!job.columnMapping) {
      throw new SqliteCsvImportValidationError(
        'The import column mapping is missing.'
      );
    }

    const staged = await tx
      .select()
      .from(importStagedRows)
      .where(
        and(
          eq(importStagedRows.importJobId, job.id),
          eq(importStagedRows.workspaceId, job.workspaceId),
          gt(importStagedRows.rowNumber, job.importedRowCount)
        )
      )
      .orderBy(asc(importStagedRows.rowNumber))
      .limit(Math.max(1, Math.min(batchSize, 1_000)));

    if (staged.length === 0) {
      if (job.importedRowCount !== job.stagedRowCount) {
        throw new SqliteCsvImportValidationError(
          'The staged CSV rows are incomplete or out of order.'
        );
      }
      const now = new Date();
      await tx
        .update(importJobs)
        .set({ finishedAt: now, status: 'succeeded', updatedAt: now })
        .where(
          and(eq(importJobs.id, job.id), eq(importJobs.status, 'running'))
        );
      await tx
        .delete(importStagedRows)
        .where(
          and(
            eq(importStagedRows.importJobId, job.id),
            eq(importStagedRows.workspaceId, job.workspaceId)
          )
        );
      await tx.insert(outboxEvents).values({
        aggregateId: job.id,
        aggregateType: 'import_job',
        eventType: 'table.csv_import_succeeded',
        payload: {
          importJobId: job.id,
          importedRowCount: job.importedRowCount,
          tableId: job.tableId,
        },
        workspaceId: job.workspaceId,
      });
      return { done: true, importedRowCount: job.importedRowCount };
    }

    const rowValues = staged.map((record) => ({
      position: `${job.createdAt.getTime().toString().padStart(13, '0')}-${job.id}-${String(record.rowNumber).padStart(10, '0')}`,
      rowNumber: record.rowNumber,
      tableId: job.tableId,
      workspaceId: job.workspaceId,
    }));
    const createdRows = await tx
      .insert(rows)
      .values(rowValues.map(({ rowNumber: _rowNumber, ...row }) => row))
      .returning({ id: rows.id, position: rows.position });
    const rowIdByPosition = new Map(
      createdRows.map((row) => [row.position, row.id])
    );
    const cellValues = staged.flatMap((record, recordIndex) => {
      const rowDefinition = rowValues[recordIndex]!;
      const rowId = rowIdByPosition.get(rowDefinition.position);
      if (!rowId) throw new Error('An imported row could not be resolved.');
      return record.values.flatMap((value, columnIndex) => {
        if (value === '') return [];
        const mappedColumn = job.columnMapping![columnIndex];
        if (!mappedColumn) {
          throw new SqliteCsvImportValidationError(
            `CSV row ${record.rowNumber} has an unexpected field.`
          );
        }
        return [
          {
            columnId: mappedColumn.columnId,
            rowId,
            tableId: job.tableId,
            valueText: value,
            valueType: 'text' as const,
            workspaceId: job.workspaceId,
          },
        ];
      });
    });
    if (cellValues.length > 0) await tx.insert(cells).values(cellValues);

    const changedColumnIds = job.columnMapping.map(({ columnId }) => columnId);
    for (const row of createdRows) {
      const changedFormulaIds = await recomputeDependentSqliteFormulasForRow(
        tx,
        {
          changedColumnIds,
          rowId: row.id,
          tableId: job.tableId,
          workspaceId: job.workspaceId,
        }
      );
      await recordSqliteRowMutationAndMaybeQueueSettlement(tx, {
        changedColumnIds: [...changedColumnIds, ...changedFormulaIds],
        rowId: row.id,
        tableId: job.tableId,
        workspaceId: job.workspaceId,
      });
    }

    const importedRowCount = staged.at(-1)!.rowNumber;
    await tx
      .update(importJobs)
      .set({ importedRowCount, updatedAt: new Date() })
      .where(and(eq(importJobs.id, job.id), eq(importJobs.status, 'running')));
    return { done: false, importedRowCount };
  });
}

export async function setSqliteCsvImportWorkerFailure(
  db: SqliteDatabase,
  input: {
    errorMessage: string;
    importJobId: string;
    retrying: boolean;
    workspaceId: string;
  }
): Promise<void> {
  await db
    .update(importJobs)
    .set({
      errorMessage: safeErrorMessage(input.errorMessage),
      finishedAt: input.retrying ? null : new Date(),
      status: input.retrying ? 'queued' : 'failed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(importJobs.id, input.importJobId),
        eq(importJobs.workspaceId, input.workspaceId),
        inArray(importJobs.status, ['queued', 'running'])
      )
    );
}

function validateFilename(filename: string): string {
  const normalized = filename.trim();
  if (!normalized || normalized.length > 255 || /\p{Cc}/u.test(normalized)) {
    throw new SqliteCsvImportValidationError('The CSV filename is invalid.');
  }
  return normalized;
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}

function toSqliteCsvImportSummary(
  job: typeof importJobs.$inferSelect
): SqliteCsvImportSummary {
  return {
    errorMessage: job.errorMessage,
    filename: job.filename,
    id: job.id,
    importedRowCount: job.importedRowCount,
    stagedRowCount: job.stagedRowCount,
    status: job.status,
  };
}
