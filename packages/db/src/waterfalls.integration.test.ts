import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  cellRuns,
  columns,
  createGridRow,
  createHttpWaterfallColumn,
  ensurePersonalWorkspace,
  listWorkspaceTables,
  outboxEvents,
  queueEnrichmentCellRun,
  users,
  workspaces,
  writeGridCell,
} from './index';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('HTTP provider waterfalls', () => {
  it('freezes an ordered provider plan and enforces workspace access', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `waterfall-owner-${crypto.randomUUID()}@example.test`,
            name: 'Waterfall Owner',
          },
          {
            email: `waterfall-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Waterfall Outsider',
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
      const [domain] = await db
        .select({ id: columns.id })
        .from(columns)
        .where(and(eq(columns.tableId, table!.id), eq(columns.name, 'Domain')));
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
        name: 'Company waterfall',
        providers: [
          {
            baseUrl: 'https://primary.example.test/search',
            credentialId: null,
            name: 'Primary',
            queryParameter: 'domain',
            resultPath: 'body.company',
          },
          {
            baseUrl: 'https://fallback.example.test/lookup',
            credentialId: null,
            name: 'Fallback',
            queryParameter: 'q',
            resultPath: 'body.result',
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

      const [run] = await db
        .select()
        .from(cellRuns)
        .where(eq(cellRuns.id, queued.runId));
      const [event] = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, queued.runId));
      expect(run).toMatchObject({
        actionId: 'execute',
        allowedHosts: ['primary.example.test', 'fallback.example.test'],
        connectorId: 'http_waterfall',
        credentialId: null,
        status: 'queued',
      });
      expect(run!.input).toMatchObject({
        kind: 'http_waterfall',
        providers: [
          {
            name: 'Primary',
            resultPath: 'body.company',
            url: 'https://primary.example.test/search?domain=acme.example',
          },
          {
            name: 'Fallback',
            resultPath: 'body.result',
            url: 'https://fallback.example.test/lookup?q=acme.example',
          },
        ],
        version: 1,
      });
      expect(run!.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(event).toMatchObject({
        eventType: 'cell.run_requested',
        publishedAt: null,
      });

      await expect(
        queueEnrichmentCellRun(db, {
          columnId: waterfall.id,
          rowId: row.id,
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toThrow('not accessible');
    } finally {
      if (workspaceIds.length > 0) {
        await db.delete(workspaces).where(inArray(workspaces.id, workspaceIds));
      }
      if (userIds.length > 0) {
        await db.delete(users).where(inArray(users.id, userIds));
      }
      await client.end();
    }
  });
});
