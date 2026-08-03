import { parseMasterKey } from '@byok-grid/security';
import { and, eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { createSqliteEncryptedCredential } from './credentials';
import {
  createSqliteConnectorActionColumn,
  markSqliteCellRunRunning,
  markSqliteCellRunSucceeded,
} from './enrichments';
import { createSqliteGridRow, writeSqliteGridCell } from './grid';
import { migrateSqliteDatabase } from './migrate';
import { processSqliteRowSettlement } from './row-automations';
import {
  cellRuns,
  cells,
  rowSettlements,
  users,
  webhookDeliveries,
} from './schema';
import { createSqliteWorkspaceTable } from './tables';
import { createSqliteWebhookDestination } from './webhooks';
import { ensureSqlitePersonalWorkspace } from './workspaces';

const userId = 'sqlite-row-automation-owner';

describe('SQLite row automation ledger', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let masterKey: ReturnType<typeof parseMasterKey>;

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `byok-grid-row-automation-${randomUUID()}.sqlite`
    );
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.db.insert(users).values({
      email: 'row-automation-owner@example.test',
      id: userId,
      name: 'Row Automation Owner',
    });
    masterKey = parseMasterKey(
      'row-automation-test-v1',
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

  it('advances on-change connector nodes before releasing settled webhooks', async () => {
    const workspaceId = (
      await ensureSqlitePersonalWorkspace(handle.db, {
        id: userId,
        name: 'Row Automation Owner',
      })
    ).id;
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Company',
      firstColumnValueType: 'text',
      name: 'Accounts',
      userId,
      workspaceId,
    });
    const automaticColumn = await createSqliteConnectorActionColumn(handle.db, {
      actionId: 'lookup',
      connectorId: 'test_firmographics',
      credentialId: null,
      inputBindings: {
        company: { columnId: table.firstColumn.id, kind: 'column' },
      },
      name: 'Firmographics',
      outputValueType: 'json',
      protocolVersion: '1.1',
      runMode: 'on_change',
      tableId: table.id,
      userId,
      workspaceId,
    });
    const signingCredential = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'webhook',
      masterKey,
      name: 'Automatic webhook signing',
      secret: { secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      userId,
      workspaceId,
    });
    const destination = await createSqliteWebhookDestination(handle.db, {
      name: 'Settled account webhook',
      signingCredentialId: signingCredential.id,
      tableId: table.id,
      triggerMode: 'row_settled',
      url: 'https://hooks.example.test/accounts',
      userId,
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
      value: { type: 'text', value: 'Acme' },
      workspaceId,
    });
    const [initialSettlement] = await handle.db
      .select()
      .from(rowSettlements)
      .where(eq(rowSettlements.rowId, row.id));
    await expect(
      processSqliteRowSettlement(handle.db, {
        rowId: row.id,
        rowVersion: initialSettlement!.rowVersion,
        settlementId: initialSettlement!.id,
        tableId: table.id,
        workspaceId,
      })
    ).resolves.toEqual({
      queuedDeliveryCount: 0,
      queuedRunCount: 1,
      status: 'succeeded',
    });
    expect(
      await handle.db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.destinationId, destination.id))
    ).toHaveLength(0);

    const [automaticCell] = await handle.db
      .select()
      .from(cells)
      .where(
        and(eq(cells.rowId, row.id), eq(cells.columnId, automaticColumn.id))
      );
    const [automaticRun] = await handle.db
      .select()
      .from(cellRuns)
      .where(eq(cellRuns.cellId, automaticCell!.id));
    const runInput = {
      cellId: automaticCell!.id,
      columnId: automaticColumn.id,
      credentialId: null,
      inputFingerprint: automaticRun!.inputFingerprint,
      rowId: row.id,
      runId: automaticRun!.id,
      workspaceId,
    };
    expect(await markSqliteCellRunRunning(handle.db, runInput)).toBe('ready');
    await markSqliteCellRunSucceeded(handle.db, {
      ...runInput,
      connectorId: 'test_firmographics',
      output: { employeeCount: 42 },
      value: { type: 'json', value: { employeeCount: 42 } },
    });

    const settlements = await handle.db
      .select()
      .from(rowSettlements)
      .where(eq(rowSettlements.rowId, row.id));
    const terminalSettlement = settlements.find(
      ({ id }) => id !== initialSettlement!.id
    );
    await expect(
      processSqliteRowSettlement(handle.db, {
        rowId: row.id,
        rowVersion: terminalSettlement!.rowVersion,
        settlementId: terminalSettlement!.id,
        tableId: table.id,
        workspaceId,
      })
    ).resolves.toEqual({
      queuedDeliveryCount: 1,
      queuedRunCount: 0,
      status: 'succeeded',
    });
    const [delivery] = await handle.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.destinationId, destination.id));
    expect(delivery).toMatchObject({
      rowVersion: terminalSettlement!.rowVersion,
      triggerMode: 'row_settled',
    });
  });
});
