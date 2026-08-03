import { migrateSqliteDatabase, openSqliteDatabase } from '@byok-grid/db';
import {
  outboxEvents,
  users,
  workspacePurgeReceipts,
  workspaces,
} from '@byok-grid/db/sqlite/schema';
import { eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ClickHouseProjectionClient } from './clickhouse';
import { parseAnalyticsProjectorConfig } from './config';
import {
  eraseWorkspaceAnalyticsBatch,
  projectAnalyticsBatch,
} from './projector';

const enabled = process.env.RUN_CLICKHOUSE_E2E === '1';
const sqliteDatabaseUrl = process.env.TEST_SQLITE_DATABASE_URL;
const clickhouseUrl = process.env.CLICKHOUSE_E2E_URL;
const clickhousePassword = process.env.CLICKHOUSE_E2E_PASSWORD;

describe.skipIf(
  !enabled || !sqliteDatabaseUrl || !clickhouseUrl || !clickhousePassword
)('SQLite to ClickHouse projection', () => {
  it('projects a leased terminal event and records its checkpoint', async () => {
    const database = await openSqliteDatabase({ url: sqliteDatabaseUrl! });
    await migrateSqliteDatabase(database.db);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const receiptIds: string[] = [];
    const config = parseAnalyticsProjectorConfig({
      SQLITE_DATABASE_URL: sqliteDatabaseUrl!,
      ANALYTICS_PROJECTION_BATCH_SIZE: '1000',
      CLICKHOUSE_ALLOW_INSECURE_HTTP: 'true',
      CLICKHOUSE_DATABASE: 'byok_grid_analytics',
      CLICKHOUSE_PASSWORD: clickhousePassword!,
      CLICKHOUSE_TABLE: 'events',
      CLICKHOUSE_URL: clickhouseUrl!,
      CLICKHOUSE_USERNAME: 'projector',
    });
    const clickhouse = new ClickHouseProjectionClient(config);
    try {
      const [owner] = await database.db
        .insert(users)
        .values({
          email: `clickhouse-${crypto.randomUUID()}@example.test`,
          name: 'ClickHouse Owner',
        })
        .returning({ id: users.id, name: users.name });
      userIds.push(owner!.id);
      const [workspace] = await database.db
        .insert(workspaces)
        .values({ name: 'ClickHouse Workspace', slug: crypto.randomUUID() })
        .returning({ id: workspaces.id });
      workspaceIds.push(workspace!.id);
      const batchId = crypto.randomUUID();
      const tableId = crypto.randomUUID();
      const [event] = await database.db
        .insert(outboxEvents)
        .values({
          aggregateId: batchId,
          aggregateType: 'ingestion_batch',
          eventType: 'table.ingestion_batch_succeeded',
          payload: {
            batchId,
            createdRowCount: 2,
            endpointId: crypto.randomUUID(),
            recordCount: 5,
            tableId,
            updatedRowCount: 3,
          },
          workspaceId: workspace!.id,
        })
        .returning({ id: outboxEvents.id });

      await clickhouse.ensureSchema();
      for (let index = 0; index < 5; index += 1) {
        await projectAnalyticsBatch({ clickhouse, config, db: database.db });
        const [stored] = await database.db
          .select({ projectedAt: outboxEvents.analyticsProjectedAt })
          .from(outboxEvents)
          .where(eq(outboxEvents.id, event!.id));
        if (stored?.projectedAt) break;
      }

      const [stored] = await database.db
        .select({ projectedAt: outboxEvents.analyticsProjectedAt })
        .from(outboxEvents)
        .where(eq(outboxEvents.id, event!.id));
      expect(stored?.projectedAt).toBeInstanceOf(Date);

      const queryUrl = new URL(clickhouseUrl!);
      queryUrl.searchParams.set('database', 'byok_grid_analytics');
      queryUrl.searchParams.set(
        'query',
        `SELECT event_id, record_count, created_row_count, updated_row_count FROM events FINAL WHERE event_id = '${event!.id}' FORMAT JSONEachRow`
      );
      const response = await fetch(queryUrl, {
        headers: {
          'x-clickhouse-key': clickhousePassword!,
          'x-clickhouse-user': 'projector',
        },
      });
      expect(response.ok).toBe(true);
      expect(JSON.parse((await response.text()).trim())).toEqual({
        created_row_count: 2,
        event_id: event!.id,
        record_count: 5,
        updated_row_count: 3,
      });

      const erasureNow = new Date('2026-08-01T02:00:00.000Z');
      const [receipt] = await database.db
        .insert(workspacePurgeReceipts)
        .values({
          actorUserId: owner!.id,
          impact: {
            auditRecords: 1,
            cells: 0,
            columns: 0,
            credentials: 0,
            executionRecords: 1,
            integrations: 0,
            invitations: 0,
            members: 1,
            rows: 0,
            tables: 0,
          },
          previewDigest: 'e'.repeat(64),
          purgedAt: new Date(erasureNow.getTime() - 3_600_001),
          reason: 'test_data',
          workspaceId: workspace!.id,
        })
        .returning({ id: workspacePurgeReceipts.id });
      receiptIds.push(receipt!.id);
      await expect(
        eraseWorkspaceAnalyticsBatch({
          clickhouse,
          config,
          db: database.db,
          runtime: {
            now: () => erasureNow,
            randomId: () => crypto.randomUUID(),
          },
        })
      ).resolves.toBe(1);

      const erasedResponse = await fetch(queryUrl, {
        headers: {
          'x-clickhouse-key': clickhousePassword!,
          'x-clickhouse-user': 'projector',
        },
      });
      expect(erasedResponse.ok).toBe(true);
      expect((await erasedResponse.text()).trim()).toBe('');
      const [erasedReceipt] = await database.db
        .select({ erasedAt: workspacePurgeReceipts.analyticsErasedAt })
        .from(workspacePurgeReceipts)
        .where(eq(workspacePurgeReceipts.id, receipt!.id));
      expect(erasedReceipt?.erasedAt).toEqual(erasureNow);
    } finally {
      if (receiptIds.length > 0) {
        await database.db
          .delete(workspacePurgeReceipts)
          .where(inArray(workspacePurgeReceipts.id, receiptIds));
      }
      if (workspaceIds.length > 0) {
        await database.db
          .delete(workspaces)
          .where(inArray(workspaces.id, workspaceIds));
      }
      if (userIds.length > 0) {
        await database.db.delete(users).where(inArray(users.id, userIds));
      }
      database.close();
    }
  });
});
