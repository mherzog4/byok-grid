import { and, eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { getSqliteGridSnapshot } from './grid';
import {
  applySqliteIngestionBatchChunk,
  createSqliteIngestionEndpoint,
  getSqliteIngestionEndpointCapability,
  hashSqliteIngestionToken,
  listSqliteIngestionEndpoints,
  markSqliteIngestionBatchRunning,
  revokeSqliteIngestionEndpoint,
  stageSqliteIngestionBatch,
} from './ingestion';
import { migrateSqliteDatabase } from './migrate';
import { ingestionEndpoints, outboxEvents, users } from './schema';
import { createSqliteWorkspaceTable } from './tables';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const userId = 'sqlite-ingestion-owner';

describe('SQLite durable push ingestion', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-ingestion-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values({
      email: 'ingestion-owner@example.test',
      id: userId,
      name: 'Ingestion Owner',
    });
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('authenticates, deduplicates, orders, patches, and revokes pushes', async () => {
    const workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: userId,
        name: 'Ingestion Owner',
      })
    ).id;
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Starter',
      firstColumnValueType: 'text',
      name: 'Pushed accounts',
      userId,
      workspaceId,
    });
    const endpoint = await createSqliteIngestionEndpoint(handle.db, {
      name: 'Airbyte companies',
      recordKeyField: 'id',
      tableId: table.id,
      userId,
      workspaceId,
    });
    const tokenHash = hashSqliteIngestionToken(endpoint.token);
    const [storedEndpoint] = await handle.db
      .select()
      .from(ingestionEndpoints)
      .where(eq(ingestionEndpoints.id, endpoint.id));
    expect(JSON.stringify(storedEndpoint)).not.toContain(endpoint.token);
    expect(
      await getSqliteIngestionEndpointCapability(handle.db, {
        endpointId: endpoint.id,
        tokenHash,
      })
    ).toEqual({ endpointId: endpoint.id, recordKeyField: 'id' });
    await expect(
      getSqliteIngestionEndpointCapability(handle.db, {
        endpointId: endpoint.id,
        tokenHash: '0'.repeat(64),
      })
    ).rejects.toThrow(/not accessible/i);

    const firstBatch = {
      fields: ['id', 'Company'],
      records: [
        { key: 'one', values: { Company: 'Acme', id: 'one' } },
        { key: 'two', values: { Company: 'Globex', id: 'two' } },
      ],
    };
    const first = await stageSqliteIngestionBatch(handle.db, {
      batch: firstBatch,
      endpointId: endpoint.id,
      idempotencyKey: 'airbyte-job-0001',
      requestDigest: 'a'.repeat(64),
      tokenHash,
    });
    expect(first).toMatchObject({ recordCount: 2, replayed: false });
    expect(
      await stageSqliteIngestionBatch(handle.db, {
        batch: firstBatch,
        endpointId: endpoint.id,
        idempotencyKey: 'airbyte-job-0001',
        requestDigest: 'a'.repeat(64),
        tokenHash,
      })
    ).toMatchObject({ id: first.id, replayed: true });
    await expect(
      stageSqliteIngestionBatch(handle.db, {
        batch: firstBatch,
        endpointId: endpoint.id,
        idempotencyKey: 'airbyte-job-0001',
        requestDigest: 'b'.repeat(64),
        tokenHash,
      })
    ).rejects.toThrow(/different request body/i);

    const firstInput = {
      batchId: first.id,
      endpointId: endpoint.id,
      tableId: table.id,
      workspaceId,
    };
    const followup = await stageSqliteIngestionBatch(handle.db, {
      batch: {
        fields: ['id', 'Company'],
        records: [{ key: 'two', values: { Company: 'Globex Inc', id: 'two' } }],
      },
      endpointId: endpoint.id,
      idempotencyKey: 'airbyte-job-0002',
      requestDigest: 'c'.repeat(64),
      tokenHash,
    });
    const followupInput = {
      batchId: followup.id,
      endpointId: endpoint.id,
      tableId: table.id,
      workspaceId,
    };
    expect(
      await markSqliteIngestionBatchRunning(handle.db, followupInput)
    ).toBe('waiting');
    expect(await markSqliteIngestionBatchRunning(handle.db, firstInput)).toBe(
      'ready'
    );
    expect(
      await applySqliteIngestionBatchChunk(handle.db, firstInput, 1)
    ).toMatchObject({ done: false });
    expect(
      await applySqliteIngestionBatchChunk(handle.db, firstInput, 1)
    ).toMatchObject({ done: false });
    expect(
      await applySqliteIngestionBatchChunk(handle.db, firstInput, 1)
    ).toMatchObject({ done: true, summary: { createdRowCount: 2 } });
    expect(
      await markSqliteIngestionBatchRunning(handle.db, followupInput)
    ).toBe('ready');
    await applySqliteIngestionBatchChunk(handle.db, followupInput);
    expect(
      (await applySqliteIngestionBatchChunk(handle.db, followupInput)).summary
        .status
    ).toBe('succeeded');

    const patch = await stageSqliteIngestionBatch(handle.db, {
      batch: {
        fields: ['id'],
        records: [{ key: 'two', values: { id: 'two' } }],
      },
      endpointId: endpoint.id,
      idempotencyKey: 'airbyte-job-0003',
      requestDigest: 'd'.repeat(64),
      tokenHash,
    });
    const patchInput = {
      batchId: patch.id,
      endpointId: endpoint.id,
      tableId: table.id,
      workspaceId,
    };
    expect(await markSqliteIngestionBatchRunning(handle.db, patchInput)).toBe(
      'ready'
    );
    await applySqliteIngestionBatchChunk(handle.db, patchInput);
    await applySqliteIngestionBatchChunk(handle.db, patchInput);
    const snapshot = await getSqliteGridSnapshot(handle.db, {
      tableId: table.id,
      userId,
      workspaceId,
    });
    const companyColumn = snapshot.columns.find(
      ({ name }) => name === 'Company'
    );
    expect(companyColumn).toBeDefined();
    expect(
      snapshot.rows
        .flatMap((row) => {
          const value = row.cells[companyColumn!.id]?.value;
          return value?.type === 'text' ? [value.value] : [];
        })
        .sort()
    ).toEqual(['Acme', 'Globex Inc']);

    const listed = await listSqliteIngestionEndpoints(handle.db, {
      tableId: table.id,
      userId,
      workspaceId,
    });
    expect(listed[0]?.lastBatch).toMatchObject({ status: 'succeeded' });
    await revokeSqliteIngestionEndpoint(handle.db, {
      endpointId: endpoint.id,
      tableId: table.id,
      userId,
      workspaceId,
    });
    await expect(
      stageSqliteIngestionBatch(handle.db, {
        batch: firstBatch,
        endpointId: endpoint.id,
        idempotencyKey: 'airbyte-job-0004',
        requestDigest: 'e'.repeat(64),
        tokenHash,
      })
    ).rejects.toThrow(/invalid/i);
    expect(
      JSON.stringify(
        await handle.db
          .select()
          .from(outboxEvents)
          .where(and(eq(outboxEvents.workspaceId, workspaceId)))
      )
    ).not.toContain(endpoint.token);
  });
});
