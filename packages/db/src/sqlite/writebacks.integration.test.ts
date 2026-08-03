import { parseMasterKey } from '@byok-grid/security';
import { and, eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { createSqliteEncryptedCredential } from './credentials';
import { createSqliteGridRow, writeSqliteGridCell } from './grid';
import { migrateSqliteDatabase } from './migrate';
import {
  outboxEvents,
  rowSettlements,
  users,
  writebackDeliveries,
} from './schema';
import { createSqliteInputColumn, createSqliteWorkspaceTable } from './tables';
import {
  createSqliteWritebackDestination,
  listSqliteWritebackDestinations,
  markSqliteWritebackDeliveryRunning,
  markSqliteWritebackDeliverySucceeded,
  queueSqliteWritebackDelivery,
  SqliteWritebackConflictError,
} from './writebacks';
import { processSqliteRowSettlement } from './row-automations';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const userId = 'sqlite-writeback-owner';

describe('SQLite writeback ledger', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let masterKey: ReturnType<typeof parseMasterKey>;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-writeback-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values({
      email: 'writeback-owner@example.test',
      id: userId,
      name: 'Writeback Owner',
    });
    masterKey = parseMasterKey(
      'writeback-test-v1',
      randomBytes(32).toString('base64')
    );
  });

  afterEach(() => {
    masterKey.value.fill(0);
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('freezes a secret-free payload and enforces delivery idempotency', async () => {
    const workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: userId,
        name: 'Writeback Owner',
      })
    ).id;
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'HubSpot ID',
      firstColumnValueType: 'text',
      name: 'Contacts',
      userId,
      workspaceId,
    });
    const company = await createSqliteInputColumn(handle.db, {
      name: 'Company',
      tableId: table.id,
      userId,
      valueType: 'text',
      workspaceId,
    });
    const row = await createSqliteGridRow(handle.db, {
      tableId: table.id,
      userId,
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: table.firstColumn.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: '12345' },
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: company.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: 'Acme' },
      workspaceId,
    });
    const credential = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'hubspot',
      masterKey,
      name: 'HubSpot token',
      secret: { accessToken: 'writeback-secret-must-stay-encrypted' },
      userId,
      workspaceId,
    });
    const destination = await createSqliteWritebackDestination(handle.db, {
      credentialId: credential.id,
      fieldMappings: [{ columnId: company.id, propertyName: 'company' }],
      filterTree: { children: [], combinator: 'and' },
      name: 'Update company',
      recordIdColumnId: table.firstColumn.id,
      tableId: table.id,
      triggerMode: 'manual',
      userId,
      workspaceId,
    });
    const deliveryId = randomUUID();
    const queued = await queueSqliteWritebackDelivery(handle.db, {
      deliveryId,
      destinationId: destination.id,
      rowId: row.id,
      tableId: table.id,
      userId,
      workspaceId,
    });
    expect(queued.status).toBe('queued');
    await writeSqliteGridCell(handle.db, {
      columnId: company.id,
      expectedVersion: 1,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: 'Changed after queue' },
      workspaceId,
    });
    const [stored] = await handle.db
      .select()
      .from(writebackDeliveries)
      .where(eq(writebackDeliveries.id, deliveryId));
    expect(stored?.payload).toMatchObject({
      properties: { company: 'Acme' },
      recordId: '12345',
    });
    expect(
      await queueSqliteWritebackDelivery(handle.db, {
        deliveryId,
        destinationId: destination.id,
        rowId: row.id,
        tableId: table.id,
        userId,
        workspaceId,
      })
    ).toMatchObject({ id: deliveryId, status: 'queued' });
    const otherDestination = await createSqliteWritebackDestination(handle.db, {
      credentialId: credential.id,
      fieldMappings: [{ columnId: company.id, propertyName: 'company' }],
      filterTree: { children: [], combinator: 'and' },
      name: 'Other update',
      recordIdColumnId: table.firstColumn.id,
      tableId: table.id,
      triggerMode: 'manual',
      userId,
      workspaceId,
    });
    await expect(
      queueSqliteWritebackDelivery(handle.db, {
        deliveryId,
        destinationId: otherDestination.id,
        rowId: row.id,
        tableId: table.id,
        userId,
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWritebackConflictError);
    const input = {
      deliveryId,
      destinationId: destination.id,
      tableId: table.id,
      workspaceId,
    };
    expect(await markSqliteWritebackDeliveryRunning(handle.db, input)).toBe(
      'ready'
    );
    await markSqliteWritebackDeliverySucceeded(handle.db, {
      ...input,
      responseStatus: 200,
    });
    const listed = await listSqliteWritebackDestinations(handle.db, {
      tableId: table.id,
      userId,
      workspaceId,
    });
    expect(listed.find(({ id }) => id === destination.id)).toMatchObject({
      id: destination.id,
      lastDelivery: { id: deliveryId, status: 'succeeded' },
    });
    const events = await handle.db.select().from(outboxEvents);
    expect(JSON.stringify(events)).not.toContain('writeback-secret');
    expect(events).toHaveLength(1);
  });

  it('settles automatic writebacks once per semantic payload and blocks excessive fan-out', async () => {
    const workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: userId,
        name: 'Writeback Owner',
      })
    ).id;
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'HubSpot ID',
      firstColumnValueType: 'text',
      name: 'Automatic contacts',
      userId,
      workspaceId,
    });
    const company = await createSqliteInputColumn(handle.db, {
      name: 'Company',
      tableId: table.id,
      userId,
      valueType: 'text',
      workspaceId,
    });
    const row = await createSqliteGridRow(handle.db, {
      tableId: table.id,
      userId,
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: table.firstColumn.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: '12345' },
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: company.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: 'Acme' },
      workspaceId,
    });
    const credential = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'hubspot',
      masterKey,
      name: 'Automatic HubSpot token',
      secret: { accessToken: 'automatic-writeback-secret' },
      userId,
      workspaceId,
    });
    const filterTree = {
      children: [
        {
          columnId: table.firstColumn.id,
          operator: 'text_equals' as const,
          value: '12345',
        },
      ],
      combinator: 'and' as const,
    };
    const destination = await createSqliteWritebackDestination(handle.db, {
      credentialId: credential.id,
      fieldMappings: [{ columnId: company.id, propertyName: 'company' }],
      filterTree,
      name: 'Automatic company update',
      recordIdColumnId: table.firstColumn.id,
      tableId: table.id,
      triggerMode: 'row_settled',
      userId,
      workspaceId,
    });

    await writeSqliteGridCell(handle.db, {
      columnId: company.id,
      expectedVersion: 1,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: 'Acme' },
      workspaceId,
    });
    const [firstSettlement] = await handle.db
      .select()
      .from(rowSettlements)
      .where(
        and(eq(rowSettlements.rowId, row.id), eq(rowSettlements.rowVersion, 4))
      );
    const firstResult = await processSqliteRowSettlement(handle.db, {
      rowId: row.id,
      rowVersion: firstSettlement!.rowVersion,
      settlementId: firstSettlement!.id,
      tableId: table.id,
      workspaceId,
    });
    expect(firstResult).toEqual({
      queuedDeliveryCount: 1,
      queuedRunCount: 0,
      status: 'succeeded',
    });
    await expect(
      processSqliteRowSettlement(handle.db, {
        rowId: row.id,
        rowVersion: firstSettlement!.rowVersion,
        settlementId: firstSettlement!.id,
        tableId: table.id,
        workspaceId,
      })
    ).resolves.toEqual(firstResult);
    const [automaticDelivery] = await handle.db
      .select()
      .from(writebackDeliveries)
      .where(eq(writebackDeliveries.destinationId, destination.id));
    expect(automaticDelivery).toMatchObject({
      filterTreeSnapshot: filterTree,
      rowVersion: 4,
      triggerMode: 'row_settled',
    });

    await writeSqliteGridCell(handle.db, {
      columnId: company.id,
      expectedVersion: 2,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: 'Acme' },
      workspaceId,
    });
    const [duplicateSettlement] = await handle.db
      .select()
      .from(rowSettlements)
      .where(eq(rowSettlements.rowVersion, 5));
    await expect(
      processSqliteRowSettlement(handle.db, {
        rowId: row.id,
        rowVersion: duplicateSettlement!.rowVersion,
        settlementId: duplicateSettlement!.id,
        tableId: table.id,
        workspaceId,
      })
    ).resolves.toMatchObject({ queuedDeliveryCount: 0, status: 'succeeded' });

    for (const suffix of ['B', 'C']) {
      await createSqliteWritebackDestination(handle.db, {
        credentialId: credential.id,
        fieldMappings: [{ columnId: company.id, propertyName: 'company' }],
        filterTree,
        name: `Automatic company update ${suffix}`,
        recordIdColumnId: table.firstColumn.id,
        tableId: table.id,
        triggerMode: 'row_settled',
        userId,
        workspaceId,
      });
    }
    await writeSqliteGridCell(handle.db, {
      columnId: company.id,
      expectedVersion: 3,
      rowId: row.id,
      tableId: table.id,
      userId,
      value: { type: 'text', value: 'Acme updated' },
      workspaceId,
    });
    const [fanoutSettlement] = await handle.db
      .select()
      .from(rowSettlements)
      .where(eq(rowSettlements.rowVersion, 6));
    await expect(
      processSqliteRowSettlement(
        handle.db,
        {
          rowId: row.id,
          rowVersion: fanoutSettlement!.rowVersion,
          settlementId: fanoutSettlement!.id,
          tableId: table.id,
          workspaceId,
        },
        { maximumAutomaticWritebacks: 2 }
      )
    ).resolves.toEqual({
      queuedDeliveryCount: 0,
      queuedRunCount: 0,
      status: 'failed',
    });
    expect(
      await handle.db
        .select()
        .from(writebackDeliveries)
        .where(
          and(
            eq(writebackDeliveries.rowId, row.id),
            eq(writebackDeliveries.rowVersion, 6)
          )
        )
    ).toHaveLength(0);
    expect(
      JSON.stringify(await handle.db.select().from(outboxEvents))
    ).not.toContain('automatic-writeback-secret');
  });
});
