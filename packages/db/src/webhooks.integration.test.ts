import { parseMasterKey } from '@byok-grid/security';
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  columns,
  createEncryptedCredential,
  createGridRow,
  createWebhookDestination,
  ensurePersonalWorkspace,
  listWebhookDestinations,
  listWorkspaceTables,
  markWebhookDeliveryRunning,
  markWebhookDeliverySucceeded,
  outboxEvents,
  queueWebhookDelivery,
  setWebhookDeliveryWorkerFailure,
  setWebhookDestinationStatus,
  users,
  WebhookAccessError,
  WebhookConflictError,
  webhookDeliveries,
  workspaces,
  writeGridCell,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('durable webhook deliveries', () => {
  it('snapshots, deduplicates, retries, and isolates row deliveries', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const masterKey = parseMasterKey(
      'webhook-test-v1',
      randomBytes(32).toString('base64')
    );
    const signingSecret = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `webhook-owner-${crypto.randomUUID()}@example.test`,
            name: 'Webhook Owner',
          },
          {
            email: `webhook-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Webhook Outsider',
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
      const [firstRow, secondRow] = await Promise.all([
        createGridRow(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        }),
        createGridRow(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        }),
      ]);
      await writeGridCell(db, {
        columnId: company!.id,
        expectedVersion: 0,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'Acme' },
        workspaceId: workspace.id,
      });
      const credential = await createEncryptedCredential(db, {
        connectorId: 'webhook',
        masterKey,
        name: 'CRM webhook signing',
        secret: { secret: signingSecret },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const destination = await createWebhookDestination(db, {
        name: 'CRM intake',
        signingCredentialId: credential.id,
        tableId: table!.id,
        url: 'https://hooks.example.com/enriched-rows',
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(destination).toMatchObject({
        name: 'CRM intake',
        status: 'active',
      });
      await expect(
        createWebhookDestination(db, {
          name: 'Stolen destination',
          signingCredentialId: credential.id,
          tableId: table!.id,
          url: 'https://hooks.example.com/stolen',
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(WebhookAccessError);

      const deliveryId = crypto.randomUUID();
      const input = {
        deliveryId,
        destinationId: destination.id,
        rowId: firstRow.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      };
      const queued = await queueWebhookDelivery(db, input);
      expect(queued).toMatchObject({
        id: deliveryId,
        rowId: firstRow.id,
        status: 'queued',
      });
      await expect(queueWebhookDelivery(db, input)).resolves.toMatchObject({
        id: deliveryId,
      });
      await expect(
        queueWebhookDelivery(db, { ...input, rowId: secondRow.id })
      ).rejects.toBeInstanceOf(WebhookConflictError);

      const [stored] = await db
        .select()
        .from(webhookDeliveries)
        .where(eq(webhookDeliveries.id, deliveryId));
      expect(stored?.payload).toMatchObject({
        data: {
          row: {
            id: firstRow.id,
            cells: expect.arrayContaining([
              expect.objectContaining({
                columnId: company!.id,
                value: { type: 'text', value: 'Acme' },
              }),
            ]),
          },
          table: { id: table!.id },
        },
        deliveryId,
        event: 'row.delivered',
        workspaceId: workspace.id,
      });
      const requested = await db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.aggregateId, deliveryId),
            eq(outboxEvents.eventType, 'table.webhook_delivery_requested')
          )
        );
      expect(requested).toHaveLength(1);
      expect(JSON.stringify({ destination, requested, stored })).not.toContain(
        signingSecret
      );

      const workerInput = {
        deliveryId,
        destinationId: destination.id,
        tableId: table!.id,
        workspaceId: workspace.id,
      };
      expect(await markWebhookDeliveryRunning(db, workerInput)).toBe('ready');
      await setWebhookDeliveryWorkerFailure(db, {
        ...workerInput,
        errorCode: 'upstream_retryable',
        errorMessage: 'Retry later.',
        responseStatus: 503,
        retrying: true,
      });
      expect(await markWebhookDeliveryRunning(db, workerInput)).toBe('ready');
      await markWebhookDeliverySucceeded(db, {
        ...workerInput,
        responseStatus: 204,
      });
      expect(await markWebhookDeliveryRunning(db, workerInput)).toBe(
        'succeeded'
      );

      const listed = await listWebhookDestinations(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(listed[0]).toMatchObject({
        id: destination.id,
        lastDelivery: {
          attempt: 2,
          id: deliveryId,
          responseStatus: 204,
          status: 'succeeded',
        },
      });
      await setWebhookDestinationStatus(db, {
        destinationId: destination.id,
        status: 'paused',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await expect(
        queueWebhookDelivery(db, {
          ...input,
          deliveryId: crypto.randomUUID(),
          rowId: secondRow.id,
        })
      ).rejects.toBeInstanceOf(WebhookConflictError);
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
});
