import { parseMasterKey } from '@byok-grid/security';
import { and, eq, inArray } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDatabase } from './client';
import {
  createConnectorActionColumn,
  createEncryptedCredential,
  createGridRow,
  EnrichmentAccessError,
  ensurePersonalWorkspace,
  listWorkspaceTables,
  queueEnrichmentCellRun,
  writeGridCell,
} from './index';
import { cellRuns, columns, outboxEvents, users, workspaces } from './schema';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!testDatabaseUrl)('connector action queue', () => {
  it('freezes mapped inputs while keeping the provider key out of durable jobs', async () => {
    const { client, db } = createDatabase(testDatabaseUrl!);
    const userIds: string[] = [];
    const workspaceIds: string[] = [];
    const masterKey = parseMasterKey(
      'connector-test-v1',
      randomBytes(32).toString('base64')
    );

    try {
      const [owner, outsider] = await db
        .insert(users)
        .values([
          {
            email: `connector-owner-${crypto.randomUUID()}@example.test`,
            name: 'Connector Owner',
          },
          {
            email: `connector-outsider-${crypto.randomUUID()}@example.test`,
            name: 'Connector Outsider',
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
      const credential = await createEncryptedCredential(db, {
        connectorId: 'hunter',
        masterKey,
        name: 'Hunter integration key',
        secret: { apiKey: 'hunter-key-must-not-enter-runs' },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const connectorColumn = await createConnectorActionColumn(db, {
        actionId: 'domain_search',
        connectorId: 'hunter',
        credentialId: credential.id,
        inputBindings: {
          domain: { columnId: domainColumn!.id, kind: 'column' },
          limit: { kind: 'literal', value: 7 },
        },
        name: 'Hunter contacts',
        outputValueType: 'json',
        protocolVersion: '1.1',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });

      const queued = await queueEnrichmentCellRun(db, {
        columnId: connectorColumn.id,
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
        actionId: 'domain_search',
        allowedHosts: [],
        connectorId: 'hunter',
        credentialId: credential.id,
        input: { domain: 'acme.example', limit: 7 },
        status: 'queued',
      });
      expect(event?.payload).toMatchObject({
        credentialId: credential.id,
        runId: queued.runId,
        workspaceId: workspace.id,
      });
      expect(JSON.stringify({ event, run })).not.toContain(
        'hunter-key-must-not-enter-runs'
      );

      const openAICredential = await createEncryptedCredential(db, {
        connectorId: 'openai',
        masterKey,
        name: 'OpenAI integration key',
        secret: { apiKey: 'openai-key-must-not-enter-runs' },
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const aiColumn = await createConnectorActionColumn(db, {
        actionId: 'generate_text',
        connectorId: 'openai',
        credentialId: openAICredential.id,
        inputBindings: {
          instructions: {
            kind: 'literal',
            value: 'Return a short company description.',
          },
          max_output_tokens: { kind: 'literal', value: 256 },
          model: { kind: 'literal', value: 'gpt-5.6-luna' },
          prompt: { columnId: domainColumn!.id, kind: 'column' },
        },
        name: 'AI company summary',
        outputValueType: 'text',
        protocolVersion: '1.1',
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      expect(aiColumn.valueType).toBe('text');

      const queuedAI = await queueEnrichmentCellRun(db, {
        columnId: aiColumn.id,
        rowId: row.id,
        tableId: table!.id,
        userId: owner!.id,
        workspaceId: workspace.id,
      });
      const [aiRun] = await db
        .select()
        .from(cellRuns)
        .where(eq(cellRuns.id, queuedAI.runId));
      expect(aiRun).toMatchObject({
        actionId: 'generate_text',
        connectorId: 'openai',
        credentialId: openAICredential.id,
        input: {
          instructions: 'Return a short company description.',
          max_output_tokens: 256,
          model: 'gpt-5.6-luna',
          prompt: 'acme.example',
        },
        status: 'queued',
      });
      expect(JSON.stringify(aiRun)).not.toContain(
        'openai-key-must-not-enter-runs'
      );

      await expect(
        createConnectorActionColumn(db, {
          actionId: 'domain_search',
          connectorId: 'hunter',
          credentialId: credential.id,
          inputBindings: {
            domain: { columnId: domainColumn!.id, kind: 'column' },
          },
          name: 'Stolen connector',
          outputValueType: 'json',
          protocolVersion: '1.1',
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
      masterKey.value.fill(0);
      await client.end();
    }
  });
});
