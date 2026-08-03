import { and, eq, inArray } from 'drizzle-orm';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  cellRuns,
  columns,
  createGridRow,
  createHttpWaterfallColumn,
  ensurePersonalWorkspace,
  getGridSnapshot,
  listWorkspaceTables,
  outboxEvents,
  queueEnrichmentCellRun,
  users,
  workspaces,
  writeGridCell,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const runNetworkE2e = process.env.RUN_NETWORK_E2E === '1';

describe.skipIf(!testDatabaseUrl || !runNetworkE2e)(
  'HTTP waterfall network end-to-end',
  () => {
    it('runs through the outbox, Hatchet, guarded HTTP, and cell provenance', async () => {
      const { client, db } = createDatabase(testDatabaseUrl!);
      const userIds: string[] = [];
      const workspaceIds: string[] = [];

      try {
        const [owner] = await db
          .insert(users)
          .values({
            email: `waterfall-e2e-${crypto.randomUUID()}@example.test`,
            name: 'Waterfall E2E',
          })
          .returning({ id: users.id, name: users.name });
        userIds.push(owner!.id);
        const workspace = await ensurePersonalWorkspace(db, owner!);
        workspaceIds.push(workspace.id);
        const [table] = await listWorkspaceTables(db, {
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        const [domain] = await db
          .select({ id: columns.id })
          .from(columns)
          .where(
            and(
              eq(columns.tableId, table!.id),
              eq(columns.workspaceId, workspace.id),
              eq(columns.name, 'Domain')
            )
          );
        const row = await createGridRow(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        await writeGridCell(db, {
          columnId: domain!.id,
          expectedVersion: 0,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          value: { type: 'text', value: 'acme.example' },
          workspaceId: workspace.id,
        });
        const waterfall = await createHttpWaterfallColumn(db, {
          inputColumnId: domain!.id,
          name: 'Live company waterfall',
          providers: [
            {
              baseUrl: 'https://httpbin.org/anything',
              credentialId: null,
              name: 'No-match provider',
              queryParameter: 'domain',
              resultPath: 'body.missing',
            },
            {
              baseUrl: 'https://httpbin.org/anything',
              credentialId: null,
              name: 'Matching provider',
              queryParameter: 'domain',
              resultPath: 'body.args.domain',
            },
          ],
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        const queued = await queueEnrichmentCellRun(db, {
          columnId: waterfall.id,
          rowId: row.id,
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });

        let run: typeof cellRuns.$inferSelect | undefined;
        for (let attempt = 0; attempt < 120; attempt += 1) {
          [run] = await db
            .select()
            .from(cellRuns)
            .where(eq(cellRuns.id, queued.runId));
          if (run?.status === 'succeeded' || run?.status === 'failed') break;
          await delay(500);
        }
        expect(
          run,
          run?.errorMessage ?? 'The run did not finish.'
        ).toMatchObject({
          status: 'succeeded',
        });
        expect(run!.output).toMatchObject({
          attempts: [
            { outcome: 'no_match', providerName: 'No-match provider' },
            { outcome: 'match', providerName: 'Matching provider' },
          ],
          kind: 'http_waterfall_result',
          matchedProviderName: 'Matching provider',
          value: 'acme.example',
        });

        const snapshot = await getGridSnapshot(db, {
          tableId: table!.id,
          userId: owner!.id,
          workspaceId: workspace.id,
        });
        expect(snapshot.rows[0]?.cells[waterfall.id]).toMatchObject({
          status: 'succeeded',
          value: {
            type: 'json',
            value: { matchedProviderName: 'Matching provider' },
          },
        });
        const [event] = await db
          .select({ publishedAt: outboxEvents.publishedAt })
          .from(outboxEvents)
          .where(eq(outboxEvents.aggregateId, queued.runId));
        expect(event?.publishedAt).toBeInstanceOf(Date);
      } finally {
        if (workspaceIds.length > 0) {
          await db
            .delete(workspaces)
            .where(inArray(workspaces.id, workspaceIds));
        }
        if (userIds.length > 0) {
          await db.delete(users).where(inArray(users.id, userIds));
        }
        await client.end();
      }
    }, 70_000);
  }
);
