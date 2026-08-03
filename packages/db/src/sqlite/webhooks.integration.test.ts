import { parseMasterKey } from '@byok-grid/security';
import { eq } from 'drizzle-orm';
import { randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { createSqliteEncryptedCredential } from './credentials';
import { createSqliteGridRow, writeSqliteGridCell } from './grid';
import { migrateSqliteDatabase } from './migrate';
import { outboxEvents, webhookDeliveries } from './schema';
import { createSqliteWorkspaceTable } from './tables';
import {
  createSqliteWebhookDestination,
  queueSqliteWebhookDelivery,
  queueSqliteWorkflowWebhookDeliveries,
  SqliteWebhookValidationError,
} from './webhooks';

const userId = '00000000-0000-4000-8000-000000000401';
const workspaceId = '00000000-0000-4000-8000-000000000402';

describe('SQLite outbound webhooks', () => {
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let masterKey: ReturnType<typeof parseMasterKey>;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-webhooks-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.client.executeMultiple(`
      insert into users (id, email, name)
        values ('${userId}', 'webhooks@example.test', 'Webhook Owner');
      insert into workspaces (id, name, slug)
        values ('${workspaceId}', 'Webhook Workspace', 'webhook-workspace');
      insert into workspace_members (workspace_id, user_id, role)
        values ('${workspaceId}', '${userId}', 'owner');
    `);
    masterKey = parseMasterKey(
      'webhook-test-v1',
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

  it('freezes payloads and keeps workflow replays idempotent', async () => {
    const table = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Company',
      firstColumnValueType: 'text',
      name: 'Prospects',
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
    const credential = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'webhook',
      masterKey,
      name: 'CRM signing key',
      secret: { secret: randomBytes(32).toString('base64url') },
      userId,
      workspaceId,
    });
    const destination = await createSqliteWebhookDestination(handle.db, {
      name: 'CRM intake',
      signingCredentialId: credential.id,
      tableId: table.id,
      triggerMode: 'manual',
      url: 'https://hooks.example.com/intake',
      userId,
      workspaceId,
    });
    const workflowInput: Parameters<
      typeof queueSqliteWorkflowWebhookDeliveries
    >[1] = {
      batch: {
        rows: [{ rowId: row.id, tableId: table.id }],
        schemaVersion: 1,
      },
      destinationId: destination.id,
      runId: '00000000-0000-4000-8000-000000000411',
      stepId: '00000000-0000-4000-8000-000000000412',
      workspaceId,
    };
    const first = await queueSqliteWorkflowWebhookDeliveries(
      handle.db,
      workflowInput
    );
    const replay = await queueSqliteWorkflowWebhookDeliveries(
      handle.db,
      workflowInput
    );
    expect(replay).toEqual(first);

    const stored = await handle.db.select().from(webhookDeliveries);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.payload.data.row.cells[0]?.value).toEqual({
      type: 'text',
      value: 'Acme',
    });
    expect(await handle.db.select().from(outboxEvents)).toHaveLength(0);

    await queueSqliteWebhookDelivery(handle.db, {
      deliveryId: randomUUID(),
      destinationId: destination.id,
      rowId: row.id,
      tableId: table.id,
      userId,
      workspaceId,
    });
    const [event] = await handle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.eventType, 'table.webhook_delivery_requested'));
    expect(event?.payload).toMatchObject({ destinationId: destination.id });
  });

  it('rejects workflow rows from a different destination table', async () => {
    const [source, other] = await Promise.all([
      createSqliteWorkspaceTable(handle.db, {
        firstColumnName: 'Company',
        firstColumnValueType: 'text',
        name: 'Source',
        userId,
        workspaceId,
      }),
      createSqliteWorkspaceTable(handle.db, {
        firstColumnName: 'Company',
        firstColumnValueType: 'text',
        name: 'Other',
        userId,
        workspaceId,
      }),
    ]);
    const row = await createSqliteGridRow(handle.db, {
      tableId: other.id,
      userId,
      workspaceId,
    });
    const credential = await createSqliteEncryptedCredential(handle.db, {
      connectorId: 'webhook',
      masterKey,
      name: 'Signing key',
      secret: { secret: randomBytes(32).toString('base64url') },
      userId,
      workspaceId,
    });
    const destination = await createSqliteWebhookDestination(handle.db, {
      name: 'Source only',
      signingCredentialId: credential.id,
      tableId: source.id,
      triggerMode: 'manual',
      url: 'https://hooks.example.com/source',
      userId,
      workspaceId,
    });

    await expect(
      queueSqliteWorkflowWebhookDeliveries(handle.db, {
        batch: {
          rows: [{ rowId: row.id, tableId: other.id }],
          schemaVersion: 1,
        },
        destinationId: destination.id,
        runId: randomUUID(),
        stepId: randomUUID(),
        workspaceId,
      })
    ).rejects.toBeInstanceOf(SqliteWebhookValidationError);
  });
});
