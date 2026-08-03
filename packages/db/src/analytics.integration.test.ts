import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  claimAnalyticsEvents,
  claimWorkspaceAnalyticsErasures,
  completeWorkspaceAnalyticsErasure,
  completeAnalyticsEvents,
  retryWorkspaceAnalyticsErasure,
  retryAnalyticsEvents,
} from './analytics';
import { createDatabase, withAuthenticatedDatabase } from './client';
import {
  outboxEvents,
  users,
  workspacePurgeReceipts,
  workspaces,
} from './schema';
import { ensurePersonalWorkspace } from './workspaces';

const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
const workerDatabaseUrl = process.env.RLS_WORKER_DATABASE_URL;
const webDatabaseUrl = process.env.RLS_DATABASE_URL;

describe.skipIf(!adminDatabaseUrl || !workerDatabaseUrl || !webDatabaseUrl)(
  'optional analytics projection leases',
  () => {
    it('claims only allowlisted events, backs off retries, and recovers stale leases', async () => {
      const admin = createDatabase(adminDatabaseUrl!);
      const worker = createDatabase(workerDatabaseUrl!);
      const web = createDatabase(webDatabaseUrl!);
      const userIds: string[] = [];
      const workspaceIds: string[] = [];
      try {
        const [owner] = await admin.db
          .insert(users)
          .values({
            email: `analytics-${crypto.randomUUID()}@example.test`,
            name: 'Analytics Owner',
          })
          .returning({ id: users.id, name: users.name });
        userIds.push(owner!.id);
        const workspace = await ensurePersonalWorkspace(admin.db, owner!);
        workspaceIds.push(workspace.id);
        const tableId = (await admin.db.query.dataTables.findFirst({
          where: (table, { eq }) => eq(table.workspaceId, workspace.id),
        }))!.id;
        const batchId = crypto.randomUUID();
        const [eligible] = await admin.db
          .insert(outboxEvents)
          .values([
            {
              aggregateId: batchId,
              aggregateType: 'ingestion_batch',
              eventType: 'table.ingestion_batch_succeeded',
              payload: {
                batchId,
                createdRowCount: 1,
                endpointId: crypto.randomUUID(),
                recordCount: 2,
                tableId,
                updatedRowCount: 1,
              },
              workspaceId: workspace.id,
            },
            {
              aggregateId: crypto.randomUUID(),
              aggregateType: 'cell',
              eventType: 'cell.run_requested',
              payload: {},
              workspaceId: workspace.id,
            },
          ])
          .returning({
            eventType: outboxEvents.eventType,
            id: outboxEvents.id,
          });
        const event = eligible!.eventType.endsWith('succeeded')
          ? eligible!
          : undefined;
        expect(event).toBeDefined();
        await expect(
          withAuthenticatedDatabase(web.db, owner!.id, (scopedDb) =>
            scopedDb
              .update(outboxEvents)
              .set({ analyticsLastError: 'browser-controlled' })
              .where(eq(outboxEvents.id, event!.id))
          )
        ).rejects.toThrow();

        const start = new Date('2026-08-01T00:00:00Z');
        const firstClaimId = crypto.randomUUID();
        const first = await claimAnalyticsEvents(worker.db, {
          claimId: firstClaimId,
          now: start,
        });
        expect(first).toHaveLength(1);
        expect(first[0]).toMatchObject({ attempt: 1, id: event!.id });
        expect(
          await claimAnalyticsEvents(worker.db, {
            claimId: crypto.randomUUID(),
            now: new Date(start.getTime() + 1_000),
          })
        ).toEqual([]);

        const retryAt = new Date(start.getTime() + 60_000);
        await retryAnalyticsEvents(worker.db, {
          claimId: firstClaimId,
          errorMessage: 'ClickHouse unavailable\nsecret-free detail',
          eventIds: [event!.id],
          retryAt,
        });
        expect(
          await claimAnalyticsEvents(worker.db, {
            claimId: crypto.randomUUID(),
            now: new Date(retryAt.getTime() - 1),
          })
        ).toEqual([]);

        const secondClaimId = crypto.randomUUID();
        const second = await claimAnalyticsEvents(worker.db, {
          claimId: secondClaimId,
          now: retryAt,
        });
        expect(second[0]).toMatchObject({ attempt: 2, id: event!.id });

        const staleClaimId = crypto.randomUUID();
        const stale = await claimAnalyticsEvents(worker.db, {
          claimId: staleClaimId,
          leaseSeconds: 30,
          now: new Date(retryAt.getTime() + 31_000),
        });
        expect(stale[0]).toMatchObject({ attempt: 3, id: event!.id });
        await completeAnalyticsEvents(worker.db, {
          claimId: staleClaimId,
          eventIds: [event!.id],
          projectedAt: new Date(retryAt.getTime() + 32_000),
        });
        expect(
          await claimAnalyticsEvents(worker.db, {
            claimId: crypto.randomUUID(),
            now: new Date(retryAt.getTime() + 60_000),
          })
        ).toEqual([]);

        const [stored] = await admin.db
          .select()
          .from(outboxEvents)
          .where(eq(outboxEvents.id, event!.id));
        expect(stored).toMatchObject({
          analyticsAttempts: 3,
          analyticsClaimId: null,
          analyticsLastError: null,
        });
        expect(stored!.analyticsProjectedAt).toBeInstanceOf(Date);
      } finally {
        if (workspaceIds.length > 0) {
          await admin.db
            .delete(workspaces)
            .where(inArray(workspaces.id, workspaceIds));
        }
        if (userIds.length > 0) {
          await admin.db.delete(users).where(inArray(users.id, userIds));
        }
        await Promise.all([
          admin.client.end(),
          web.client.end(),
          worker.client.end(),
        ]);
      }
    });

    it('leases delayed workspace erasures with retry and stale-claim recovery', async () => {
      const admin = createDatabase(adminDatabaseUrl!);
      const worker = createDatabase(workerDatabaseUrl!);
      const web = createDatabase(webDatabaseUrl!);
      const userIds: string[] = [];
      const workspaceIds: string[] = [];
      const receiptIds: string[] = [];
      try {
        const [owner] = await admin.db
          .insert(users)
          .values({
            email: `analytics-erasure-${crypto.randomUUID()}@example.test`,
            name: 'Analytics Erasure Owner',
          })
          .returning({ id: users.id, name: users.name });
        userIds.push(owner!.id);
        const workspace = await ensurePersonalWorkspace(admin.db, owner!);
        workspaceIds.push(workspace.id);
        const purgedAt = new Date('2026-08-01T00:00:00.000Z');
        const [receipt] = await admin.db
          .insert(workspacePurgeReceipts)
          .values({
            actorUserId: owner!.id,
            impact: {
              auditRecords: 1,
              cells: 2,
              columns: 2,
              credentials: 0,
              executionRecords: 1,
              integrations: 0,
              invitations: 0,
              members: 1,
              rows: 2,
              tables: 1,
            },
            previewDigest: 'a'.repeat(64),
            purgedAt,
            reason: 'test_data',
            workspaceId: workspace.id,
          })
          .returning({ id: workspacePurgeReceipts.id });
        receiptIds.push(receipt!.id);

        expect(
          await claimWorkspaceAnalyticsErasures(worker.db, {
            claimId: crypto.randomUUID(),
            now: new Date(purgedAt.getTime() + 3_600_000 - 1),
          })
        ).toEqual([]);

        const firstClaimId = crypto.randomUUID();
        const first = await claimWorkspaceAnalyticsErasures(worker.db, {
          claimId: firstClaimId,
          now: new Date(purgedAt.getTime() + 3_600_000),
        });
        expect(first).toEqual([
          {
            attempt: 1,
            receiptId: receipt!.id,
            workspaceId: workspace.id,
          },
        ]);
        const retryAt = new Date(purgedAt.getTime() + 3_660_000);
        await retryWorkspaceAnalyticsErasure(worker.db, {
          claimId: firstClaimId,
          errorMessage: 'ClickHouse unavailable\nwithout secrets',
          receiptId: receipt!.id,
          retryAt,
        });
        expect(
          await claimWorkspaceAnalyticsErasures(worker.db, {
            claimId: crypto.randomUUID(),
            now: new Date(retryAt.getTime() - 1),
          })
        ).toEqual([]);

        const secondClaimId = crypto.randomUUID();
        expect(
          await claimWorkspaceAnalyticsErasures(worker.db, {
            claimId: secondClaimId,
            now: retryAt,
          })
        ).toEqual([expect.objectContaining({ attempt: 2 })]);
        const staleClaimId = crypto.randomUUID();
        expect(
          await claimWorkspaceAnalyticsErasures(worker.db, {
            claimId: staleClaimId,
            leaseSeconds: 30,
            now: new Date(retryAt.getTime() + 31_000),
          })
        ).toEqual([expect.objectContaining({ attempt: 3 })]);
        const erasedAt = new Date(retryAt.getTime() + 32_000);
        await completeWorkspaceAnalyticsErasure(worker.db, {
          claimId: staleClaimId,
          erasedAt,
          receiptId: receipt!.id,
        });

        const [stored] = await admin.db
          .select()
          .from(workspacePurgeReceipts)
          .where(eq(workspacePurgeReceipts.id, receipt!.id));
        expect(stored).toMatchObject({
          analyticsEraseAttempts: 3,
          analyticsEraseClaimId: null,
          analyticsEraseLastError: null,
          analyticsErasedAt: erasedAt,
        });
        await expect(
          withAuthenticatedDatabase(web.db, owner!.id, (scopedDb) =>
            scopedDb
              .update(workspacePurgeReceipts)
              .set({ analyticsEraseLastError: 'browser-controlled' })
              .where(eq(workspacePurgeReceipts.id, receipt!.id))
          )
        ).rejects.toThrow();
      } finally {
        if (receiptIds.length > 0) {
          await admin.db
            .delete(workspacePurgeReceipts)
            .where(inArray(workspacePurgeReceipts.id, receiptIds));
        }
        if (workspaceIds.length > 0) {
          await admin.db
            .delete(workspaces)
            .where(inArray(workspaces.id, workspaceIds));
        }
        if (userIds.length > 0) {
          await admin.db.delete(users).where(inArray(users.id, userIds));
        }
        await Promise.all([
          admin.client.end(),
          web.client.end(),
          worker.client.end(),
        ]);
      }
    });
  }
);
