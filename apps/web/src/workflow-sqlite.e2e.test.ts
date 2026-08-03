import { createClient, type Client } from '@libsql/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const runE2e = process.env.RUN_SQLITE_WEB_E2E === '1';
const databaseUrl = process.env.TEST_SQLITE_DATABASE_URL;
const appUrl = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3000';

describe.skipIf(!runE2e || !databaseUrl)(
  'SQLite auth and visual workflow HTTP end-to-end',
  () => {
    let client: Client | undefined;
    const email = `workflow-sqlite-${crypto.randomUUID()}@example.test`;
    let userId: string | undefined;
    let workspaceId: string | undefined;

    beforeAll(async () => {
      client = createClient({ url: databaseUrl! });
      await client.execute('PRAGMA foreign_keys = ON');
    });

    afterAll(async () => {
      if (workspaceId) {
        await client!.execute({
          args: [workspaceId],
          sql: 'delete from workspaces where id = ?',
        });
      }
      if (userId) {
        await client!.execute({
          args: [userId],
          sql: 'delete from users where id = ?',
        });
      }
      client?.close();
    });

    it('authors SQLite grid data, publishes a graph, and queues its run', async () => {
      const signup = await fetch(`${appUrl}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email,
          name: 'SQLite Workflow E2E',
          password: 'correct-horse-battery-staple-workflow-e2e',
        }),
        headers: { 'content-type': 'application/json', origin: appUrl },
        method: 'POST',
      });
      expect(signup.status, await signup.clone().text()).toBe(200);
      const cookie = signup.headers
        .getSetCookie()
        .map((value) => value.split(';', 1)[0])
        .join('; ');
      expect(cookie).not.toBe('');

      const user = await one('select id from users where email = ?', email);
      userId = String(user.id);
      const membership = await one(
        'select workspace_id from workspace_members where user_id = ?',
        userId
      );
      workspaceId = String(membership.workspace_id);
      const table = await one(
        'select id from data_tables where workspace_id = ? order by created_at limit 1',
        workspaceId
      );
      const tableId = String(table.id);
      const column = await one(
        'select id from columns where table_id = ? order by position limit 1',
        tableId
      );
      const columnId = String(column.id);

      const app = await fetch(`${appUrl}/app`, { headers: { cookie } });
      expect(app.status).toBe(200);
      const appHtml = await app.text();
      expect(appHtml).toContain('Engineer the row journey');
      expect(appHtml).toContain('Add row');

      const tableCollectionUrl = `${appUrl}/api/workspaces/${workspaceId}/tables`;
      const createdTableResponse = await fetch(tableCollectionUrl, {
        body: JSON.stringify({
          firstColumnName: 'Company',
          firstColumnValueType: 'text',
          name: 'Prospects',
        }),
        headers: { 'content-type': 'application/json', cookie, origin: appUrl },
        method: 'POST',
      });
      expect(createdTableResponse.status).toBe(201);
      const createdTable = (await createdTableResponse.json()) as {
        id: string;
      };
      const renamedTableResponse = await fetch(
        `${tableCollectionUrl}/${createdTable.id}`,
        {
          body: JSON.stringify({ name: 'Qualified prospects' }),
          headers: {
            'content-type': 'application/json',
            cookie,
            origin: appUrl,
          },
          method: 'PATCH',
        }
      );
      expect(renamedTableResponse.status).toBe(200);
      expect(await renamedTableResponse.json()).toMatchObject({
        id: createdTable.id,
        name: 'Qualified prospects',
      });

      const columnResponse = await fetch(
        `${tableCollectionUrl}/${tableId}/columns/input`,
        {
          body: JSON.stringify({ name: 'Employee count', valueType: 'number' }),
          headers: {
            'content-type': 'application/json',
            cookie,
            origin: appUrl,
          },
          method: 'POST',
        }
      );
      expect(columnResponse.status).toBe(201);

      const rowResponse = await fetch(`${tableCollectionUrl}/${tableId}/rows`, {
        headers: { cookie, origin: appUrl },
        method: 'POST',
      });
      expect(rowResponse.status).toBe(201);
      const row = (await rowResponse.json()) as { id: string };
      const cellUrl = `${tableCollectionUrl}/${tableId}/rows/${row.id}/cells/${columnId}`;
      const cellResponse = await fetch(cellUrl, {
        body: JSON.stringify({
          expectedVersion: 0,
          value: { type: 'text', value: 'Acme' },
        }),
        headers: { 'content-type': 'application/json', cookie, origin: appUrl },
        method: 'PUT',
      });
      expect(cellResponse.status).toBe(200);
      expect(await cellResponse.json()).toMatchObject({
        value: { type: 'text', value: 'Acme' },
        version: 1,
      });

      const staleCellResponse = await fetch(cellUrl, {
        body: JSON.stringify({
          expectedVersion: 0,
          value: { type: 'text', value: 'Stale overwrite' },
        }),
        headers: { 'content-type': 'application/json', cookie, origin: appUrl },
        method: 'PUT',
      });
      expect(staleCellResponse.status).toBe(409);

      const storedRowResponse = await fetch(
        `${tableCollectionUrl}/${tableId}/rows/${row.id}`,
        { headers: { cookie } }
      );
      expect(storedRowResponse.status).toBe(200);
      const storedRow = (await storedRowResponse.json()) as {
        cells: Record<string, { value: unknown; version: number }>;
      };
      expect(storedRow.cells[columnId]).toMatchObject({
        value: { type: 'text', value: 'Acme' },
        version: 1,
      });

      const collectionUrl = `${appUrl}/api/workspaces/${workspaceId}/workflows`;
      const createdResponse = await fetch(collectionUrl, {
        body: JSON.stringify({
          graph: {
            edges: [],
            nodes: [],
            schemaVersion: 1,
            viewport: { x: 0, y: 0, zoom: 1 },
          },
          name: 'E2E row copy',
        }),
        headers: { 'content-type': 'application/json', cookie, origin: appUrl },
        method: 'POST',
      });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as {
        draftRevision: number;
        id: string;
      };
      expect(created.draftRevision).toBe(1);

      const triggerId = crypto.randomUUID();
      const destinationId = crypto.randomUUID();
      const graph = {
        edges: [
          {
            id: crypto.randomUUID(),
            sourceHandle: 'rows',
            sourceNodeId: triggerId,
            targetHandle: 'rows',
            targetNodeId: destinationId,
          },
        ],
        nodes: [
          {
            configuration: { searchQuery: null, tableId, viewId: null },
            id: triggerId,
            kind: 'trigger.table_rows',
            name: 'Rows',
            position: { x: 0, y: 0 },
          },
          {
            configuration: {
              columnMappings: [
                { sourceColumnId: columnId, targetColumnId: columnId },
              ],
              tableId,
            },
            id: destinationId,
            kind: 'destination.write_table',
            name: 'Write',
            position: { x: 300, y: 0 },
          },
        ],
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
      };
      const updatedResponse = await fetch(`${collectionUrl}/${created.id}`, {
        body: JSON.stringify({
          expectedRevision: created.draftRevision,
          graph,
          name: 'E2E row copy',
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: appUrl,
        },
        method: 'PATCH',
      });
      expect(updatedResponse.status).toBe(200);
      const updated = (await updatedResponse.json()) as {
        draftRevision: number;
      };
      expect(updated.draftRevision).toBe(2);

      const publishedResponse = await fetch(
        `${collectionUrl}/${created.id}/publish`,
        {
          body: JSON.stringify({
            expectedRevision: updated.draftRevision,
          }),
          headers: {
            'content-type': 'application/json',
            cookie,
            origin: appUrl,
          },
          method: 'POST',
        }
      );
      expect(publishedResponse.status).toBe(200);
      expect(await publishedResponse.json()).toMatchObject({
        publishedVersion: 1,
        state: 'active',
      });

      const runResponse = await fetch(`${collectionUrl}/${created.id}/runs`, {
        body: JSON.stringify({ input: { source: 'e2e' } }),
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: appUrl,
        },
        method: 'POST',
      });
      expect(runResponse.status).toBe(202);
      const run = (await runResponse.json()) as { id: string; status: string };
      expect(run.status).toBe('queued');
      const runHistoryResponse = await fetch(
        `${collectionUrl}/${created.id}/runs`,
        { headers: { cookie } }
      );
      expect(runHistoryResponse.status).toBe(200);
      const runHistory = (await runHistoryResponse.json()) as Array<{
        id: string;
        status: string;
        steps: Array<{ status: string }>;
      }>;
      expect(runHistory[0]).toMatchObject({
        id: run.id,
        status: 'queued',
      });
      expect(runHistory[0]?.steps).toHaveLength(2);
      expect(runHistory[0]?.steps.map((step) => step.status).sort()).toEqual([
        'blocked',
        'ready',
      ]);
      const storedRun = await one(
        'select workflow_version, graph_digest, status from workflow_runs where id = ?',
        run.id
      );
      expect(storedRun).toMatchObject({
        status: 'queued',
        workflow_version: 1,
      });
      expect(String(storedRun.graph_digest)).toMatch(/^[0-9a-f]{64}$/);
      const steps = await client!.execute({
        args: [run.id],
        sql: 'select step_id, status from workflow_step_runs where run_id = ? order by step_id',
      });
      expect(steps.rows).toHaveLength(2);
      expect(steps.rows.map((row) => row.status).sort()).toEqual([
        'blocked',
        'ready',
      ]);
    }, 30_000);

    async function one(sql: string, argument: string) {
      const result = await client!.execute({ args: [argument], sql });
      const row = result.rows[0];
      if (!row) throw new Error(`Missing SQLite fixture for ${sql}`);
      return row;
    }
  }
);
