import {
  assertSqliteCsvImportTableAccess,
  createSqliteCsvImportJob,
  failSqliteCsvImportUpload,
  listSqliteCsvImports,
  queueSqliteCsvImport,
  SqliteCsvImportAccessError,
  SqliteCsvImportValidationError,
  stageSqliteCsvImportRows,
} from '@byok-grid/db';
import { getApiUser } from '@/lib/grid-api';
import { unexpectedApiErrorResponse } from '@/lib/request-correlation';
import { sqliteDb } from '@/lib/sqlite-database';
import { parse } from 'csv-parse';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const runtime = 'nodejs';

const maximumUploadBytes = 50 * 1024 * 1024;
const maximumRows = 100_000;
const stagingBatchSize = 500;

interface RouteContext {
  params: Promise<{ tableId: string; workspaceId: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  try {
    const { tableId, workspaceId } = await context.params;
    return Response.json(
      await listSqliteCsvImports(sqliteDb, {
        tableId,
        userId: user.id,
        workspaceId,
      })
    );
  } catch (error) {
    return importErrorResponse(error, request);
  }
}

export async function POST(request: Request, context: RouteContext) {
  const user = await getApiUser(request);
  if (!user) return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  if (!request.body) {
    return Response.json({ error: 'A CSV file is required.' }, { status: 400 });
  }
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maximumUploadBytes) {
    return Response.json(
      { error: 'CSV files may be at most 50 MiB.' },
      { status: 413 }
    );
  }

  const { tableId, workspaceId } = await context.params;
  try {
    await assertSqliteCsvImportTableAccess(sqliteDb, {
      tableId,
      userId: user.id,
      workspaceId,
    });
  } catch (error) {
    return importErrorResponse(error, request);
  }

  const filename =
    new URL(request.url).searchParams.get('filename')?.trim() || 'import.csv';
  const byteLimiter = new UploadByteLimit(maximumUploadBytes);
  const parser = parse({
    bom: true,
    columns: false,
    encoding: 'utf8',
    max_record_size: 1024 * 1024,
    relax_column_count: false,
    skip_empty_lines: true,
    skip_records_with_error: false,
  });
  const source = Readable.fromWeb(
    request.body as unknown as import('node:stream/web').ReadableStream
  );
  const streamFinished = pipeline(source, byteLimiter, parser);
  let importJobId: string | undefined;

  try {
    let headers: string[] | undefined;
    let rowNumber = 0;
    let batch: Array<{ rowNumber: number; values: string[] }> = [];

    for await (const record of parser) {
      if (
        !Array.isArray(record) ||
        !record.every((value) => typeof value === 'string')
      ) {
        throw new SqliteCsvImportValidationError(
          'The CSV contains a non-text record.'
        );
      }
      const values = record as string[];
      if (!headers) {
        const parsedHeaders = values;
        headers = parsedHeaders;
        const job = await createSqliteCsvImportJob(sqliteDb, {
          filename,
          headers: parsedHeaders,
          tableId,
          userId: user.id,
          workspaceId,
        });
        importJobId = job.id;
        continue;
      }
      rowNumber += 1;
      if (rowNumber > maximumRows) {
        throw new CsvUploadLimitError(
          `CSV files may contain at most ${maximumRows.toLocaleString()} rows.`
        );
      }
      if (values.length !== headers.length) {
        throw new SqliteCsvImportValidationError(
          `CSV row ${rowNumber} has ${values.length} fields; expected ${headers.length}.`
        );
      }
      batch.push({ rowNumber, values });
      if (batch.length >= stagingBatchSize) {
        const rowsToStage = batch;
        batch = [];
        await stageSqliteCsvImportRows(sqliteDb, {
          importJobId: importJobId!,
          rows: rowsToStage,
          uploadedBytes: byteLimiter.bytesRead,
          userId: user.id,
          workspaceId,
        });
      }
    }
    await streamFinished;
    if (!headers || !importJobId) {
      throw new SqliteCsvImportValidationError(
        'The CSV does not contain a header row.'
      );
    }
    const completedImportJobId = importJobId;
    if (batch.length > 0) {
      await stageSqliteCsvImportRows(sqliteDb, {
        importJobId: completedImportJobId,
        rows: batch,
        uploadedBytes: byteLimiter.bytesRead,
        userId: user.id,
        workspaceId,
      });
    }
    const queued = await queueSqliteCsvImport(sqliteDb, {
      importJobId: completedImportJobId,
      userId: user.id,
      workspaceId,
    });
    return Response.json(queued, { status: 202 });
  } catch (error) {
    parser.destroy();
    await streamFinished.catch(() => undefined);
    if (importJobId) {
      const failedImportJobId = importJobId;
      await failSqliteCsvImportUpload(sqliteDb, {
        errorMessage:
          error instanceof Error ? error.message : 'The CSV upload failed.',
        importJobId: failedImportJobId,
        userId: user.id,
        workspaceId,
      });
    }
    return importErrorResponse(error, request);
  }
}

class CsvUploadLimitError extends Error {}

class UploadByteLimit extends Transform {
  bytesRead = 0;

  constructor(private readonly maximumBytes: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    this.bytesRead += chunk.byteLength;
    if (this.bytesRead > this.maximumBytes) {
      callback(new CsvUploadLimitError('CSV files may be at most 50 MiB.'));
      return;
    }
    callback(null, chunk);
  }
}

function importErrorResponse(error: unknown, request: Request): Response {
  if (error instanceof SqliteCsvImportAccessError) {
    return Response.json({ error: 'Not found.' }, { status: 404 });
  }
  if (error instanceof CsvUploadLimitError) {
    return Response.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof SqliteCsvImportValidationError) {
    return Response.json({ error: error.message }, { status: 422 });
  }
  const maybeCsvError = error as { code?: unknown };
  if (
    typeof maybeCsvError?.code === 'string' &&
    maybeCsvError.code.startsWith('CSV_')
  ) {
    return Response.json(
      { error: 'The CSV is malformed or has inconsistent columns.' },
      { status: 422 }
    );
  }
  return unexpectedApiErrorResponse('csv-import', error, request);
}
