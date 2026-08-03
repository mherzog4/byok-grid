import { and, eq, inArray } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  createGridRow,
  createHttpEnrichmentColumn,
  EnrichmentAccessError,
  ensurePersonalWorkspace,
  listWorkspaceTables,
  queueHttpCellRun,
  writeGridCell,
} from './index';
import {
  cellRuns,
  cells,
  columns,
  outboxEvents,
  users,
  workspaces,
} from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('enrichment queue', () => {
  it('freezes row input and creates a durable outbox event atomically', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `run-owner-${crypto.randomUUID()}@example.test`,
            name: 'Run Owner',
          },
          {
            email: `run-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Run Outsider',
          },
        ])
        .returning({ id: users.id, name: users.name });
      expect(owner).toBeDefined();
      expect(outsider).toBeDefined();
      userIds.push(owner!.id, outsider!.id);

      const workspace = await ensurePersonalWorkspace(db, owner!);
      workspaceIds.push(workspace.id);
      const [table] = await listWorkspaceTables(db, {
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const [domainColumn] = await db
        .select({ id: columns.id })
        .from(columns)
        .where(and(eq(columns.tableId, table!.id), eq(columns.name, 'Domain')));
      expect(domainColumn).toBeDefined();

      const row = await createGridRow(db, {
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      await writeGridCell(db, {
        columnId: domainColumn!.id,
        expectedVersion: 0,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        value: { type: 'text', value: 'acme.example' },
        workspaceId: workspace.id,
      });

      const enrichmentColumn = await createHttpEnrichmentColumn(db, {
        baseUrl: 'https://api.example.test/company',
        credentialId: null,
        inputColumnId: domainColumn!.id,
        name: 'Firmographics',
        queryParameter: 'domain',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const queued = await queueHttpCellRun(db, {
        columnId: enrichmentColumn.id,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });

      const [run] = await db
        .select()
        .from(cellRuns)
        .where(eq(cellRuns.id, queued.runId));
      const [targetCell] = await db
        .select()
        .from(cells)
        .where(eq(cells.id, queued.cellId));
      const [event] = await db
        .select()
        .from(outboxEvents)
        .where(eq(outboxEvents.aggregateId, queued.runId));

      expect(run).toMatchObject({
        actionId: 'request',
        allowedHosts: ['api.example.test'],
        connectorId: 'http',
        credentialId: null,
        status: 'queued',
      });
      expect(run!.input).toEqual({
        method: 'GET',
        url: 'https://api.example.test/company?domain=acme.example',
      });
      expect(run!.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(targetCell).toMatchObject({
        status: 'queued',
        valueType: 'empty',
      });
      expect(event).toMatchObject({
        eventType: 'cell.run_requested',
        publishedAt: null,
      });
      expect(event!.payload).toMatchObject({
        cellId: queued.cellId,
        columnId: enrichmentColumn.id,
        rowId: row.id,
        runId: queued.runId,
        workspaceId: workspace.id,
      });

      await expect(
        queueHttpCellRun(db, {
          columnId: enrichmentColumn.id,
          rowId: row.id,
          tableId: table!.id,
          userId: outsider!.id,
          workspaceId: workspace.id,
        })
      ).rejects.toBeInstanceOf(EnrichmentAccessError);
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
