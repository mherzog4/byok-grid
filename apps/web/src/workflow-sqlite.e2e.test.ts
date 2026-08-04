import { createClient, type Client } from '@libsql/client';
import { SQLITE_BUSY_TIMEOUT_MS } from '@byok-grid/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MAXIMUM_API_JSON_BODY_BYTES,
  MAXIMUM_AUTH_REQUEST_BODY_BYTES,
} from './lib/request-body';

const runE2e = process.env.RUN_SQLITE_WEB_E2E === '1';
const verifyWorkerExecution = process.env.VERIFY_WORKFLOW_EXECUTION === '1';
const drainDrillRows = parseDrainDrillRows(
  process.env.WORKFLOW_DRAIN_DRILL_ROWS
);
const databaseUrl = process.env.TEST_SQLITE_DATABASE_URL;
const appUrl = process.env.TEST_APP_URL ?? 'http://127.0.0.1:3000';
const requestOrigin = process.env.TEST_APP_ORIGIN ?? appUrl;

describe.skipIf(!runE2e || !databaseUrl)(
  'SQLite auth and visual workflow HTTP end-to-end',
  () => {
    let client: Client | undefined;
    const email =
      process.env.WORKFLOW_DRILL_EMAIL ??
      `workflow-sqlite-${crypto.randomUUID()}@example.test`;
    const password = `workflow-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    let userId: string | undefined;
    let workspaceId: string | undefined;

    beforeAll(async () => {
      client = createClient({
        ...(process.env.TEST_SQLITE_AUTH_TOKEN
          ? { authToken: process.env.TEST_SQLITE_AUTH_TOKEN }
          : {}),
        timeout: SQLITE_BUSY_TIMEOUT_MS,
        url: databaseUrl!,
      });
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
      const crossOriginSignup = await fetch(
        `${appUrl}/api/auth/sign-up/email`,
        {
          body: JSON.stringify({
            email,
            name: 'Cross-origin attempt',
            password,
          }),
          headers: {
            'content-type': 'application/json',
            origin: 'https://attacker.example',
            'sec-fetch-site': 'cross-site',
          },
          method: 'POST',
        }
      );
      expect(crossOriginSignup.status).toBe(403);
      expect(crossOriginSignup.headers.get('cache-control')).toBe('no-store');
      const rejectionNonce = expectSecurityHeaders(crossOriginSignup.headers);
      await expect(crossOriginSignup.json()).resolves.toEqual({
        error: 'Cross-origin API mutations are not allowed.',
      });

      const oversizedSignup = await fetch(`${appUrl}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email,
          name: 'x'.repeat(MAXIMUM_AUTH_REQUEST_BODY_BYTES),
          password,
        }),
        headers: {
          'content-type': 'application/json',
          origin: requestOrigin,
        },
        method: 'POST',
      });
      expect(oversizedSignup.status, await oversizedSignup.clone().text()).toBe(
        413
      );
      await expect(oversizedSignup.json()).resolves.toEqual({
        error: 'The request body exceeds 64 KiB.',
      });

      const signup = await fetch(`${appUrl}/api/auth/sign-up/email`, {
        body: JSON.stringify({
          email,
          name: 'SQLite Workflow E2E',
          password,
        }),
        headers: {
          'content-type': 'application/json',
          origin: requestOrigin,
        },
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
      const appNonce = expectSecurityHeaders(app.headers);
      expect(appNonce).not.toBe(rejectionNonce);
      const appHtml = await app.text();
      expectRenderedScriptNonces(appHtml, appNonce);
      expect(appHtml).toContain('Engineer the row journey');
      expect(appHtml).toContain('Add row');

      const tableCollectionUrl = `${appUrl}/api/workspaces/${workspaceId}/tables`;
      const crossOriginTableResponse = await fetch(tableCollectionUrl, {
        body: JSON.stringify({
          firstColumnName: 'Company',
          firstColumnValueType: 'text',
          name: 'Cross-origin table',
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: 'https://attacker.example',
        },
        method: 'POST',
      });
      expect(crossOriginTableResponse.status).toBe(403);
      await expect(crossOriginTableResponse.json()).resolves.toEqual({
        error: 'Cross-origin API mutations are not allowed.',
      });

      const oversizedTableResponse = await fetch(tableCollectionUrl, {
        body: JSON.stringify({
          firstColumnName: 'Company',
          firstColumnValueType: 'text',
          name: 'x'.repeat(MAXIMUM_API_JSON_BODY_BYTES),
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: requestOrigin,
        },
        method: 'POST',
      });
      expect(oversizedTableResponse.status).toBe(413);
      expect(await oversizedTableResponse.json()).toEqual({
        error: 'The request body exceeds 5 MiB.',
      });

      const createdTableResponse = await fetch(tableCollectionUrl, {
        body: JSON.stringify({
          firstColumnName: 'Company',
          firstColumnValueType: 'text',
          name: 'Prospects',
        }),
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: requestOrigin,
        },
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
            origin: requestOrigin,
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
          body: JSON.stringify({
            name: 'Employee count',
            valueType: 'number',
          }),
          headers: {
            'content-type': 'application/json',
            cookie,
            origin: requestOrigin,
          },
          method: 'POST',
        }
      );
      expect(columnResponse.status).toBe(201);

      const rowResponse = await fetch(`${tableCollectionUrl}/${tableId}/rows`, {
        headers: { cookie, origin: requestOrigin },
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
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: requestOrigin,
        },
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
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: requestOrigin,
        },
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

      if (drainDrillRows !== null) {
        await seedWorkflowRows(tableId, columnId, drainDrillRows);
      }

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
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: requestOrigin,
        },
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
      const filterIds =
        drainDrillRows === null
          ? []
          : Array.from({ length: 98 }, () => crypto.randomUUID());
      const executionNodeIds = [triggerId, ...filterIds, destinationId];
      const graph = {
        edges: executionNodeIds.slice(0, -1).map((sourceNodeId, index) => ({
          id: crypto.randomUUID(),
          sourceHandle: index === 0 ? 'rows' : 'matched',
          sourceNodeId,
          targetHandle: 'rows',
          targetNodeId: executionNodeIds[index + 1]!,
        })),
        nodes: [
          {
            configuration: { searchQuery: null, tableId, viewId: null },
            id: triggerId,
            kind: 'trigger.table_rows',
            name: 'Rows',
            position: { x: 0, y: 0 },
          },
          ...filterIds.map((id, index) => ({
            configuration: {
              filterTree: { children: [], combinator: 'and' },
            },
            id,
            kind: 'logic.filter',
            name: `Drain filter ${index + 1}`,
            position: { x: 300 + index * 10, y: 0 },
          })),
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
            position: { x: 1_300, y: 0 },
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
          origin: requestOrigin,
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
            origin: requestOrigin,
          },
          method: 'POST',
        }
      );
      expect(publishedResponse.status).toBe(200);
      expect(await publishedResponse.json()).toMatchObject({
        publishedVersion: 1,
        state: 'active',
      });

      const runCollectionUrl = `${collectionUrl}/${created.id}/runs`;
      const runResponse = await fetch(runCollectionUrl, {
        body: JSON.stringify({ input: { source: 'e2e' } }),
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: requestOrigin,
        },
        method: 'POST',
      });
      expect(runResponse.status).toBe(202);
      const run = (await runResponse.json()) as {
        id: string;
        status: string;
      };
      expect(run.status).toBe('queued');

      if (drainDrillRows !== null) {
        await waitForRunningStep(runCollectionUrl, cookie, run.id);
        console.log(
          JSON.stringify({
            marker: 'BYOK_GRID_DRAIN_DRILL_IN_FLIGHT',
            rowCount: drainDrillRows,
            runId: run.id,
          })
        );
      }

      const runHistoryResponse = await fetch(runCollectionUrl, {
        headers: { cookie },
      });
      expect(runHistoryResponse.status).toBe(200);
      const runHistory = (await runHistoryResponse.json()) as Array<{
        id: string;
        status: string;
        steps: Array<{ status: string }>;
      }>;
      expect(runHistory[0]?.id).toBe(run.id);
      if (drainDrillRows === null) {
        expect(runHistory[0]?.status).toBe('queued');
      }
      expect(runHistory[0]?.steps).toHaveLength(executionNodeIds.length);
      const storedRun = await one(
        'select workflow_version, graph_digest, status from workflow_runs where id = ?',
        run.id
      );
      expect(storedRun.workflow_version).toBe(1);
      if (drainDrillRows === null) {
        expect(storedRun.status).toBe('queued');
      }
      expect(String(storedRun.graph_digest)).toMatch(/^[0-9a-f]{64}$/);
      const steps = await client!.execute({
        args: [run.id],
        sql: 'select step_id, status from workflow_step_runs where run_id = ? order by step_id',
      });
      expect(steps.rows).toHaveLength(executionNodeIds.length);
      if (drainDrillRows === null) {
        expect(steps.rows.map((row) => row.status).sort()).toEqual([
          'blocked',
          'ready',
        ]);
      }

      if (verifyWorkerExecution) {
        const terminalRun = await waitForTerminalRun(
          runCollectionUrl,
          cookie,
          run.id
        );
        expect(terminalRun.status).toBe('succeeded');
        expect(terminalRun.steps.map((step) => step.status)).toHaveLength(
          executionNodeIds.length
        );
        expect(
          terminalRun.steps.every((step) => step.status === 'succeeded')
        ).toBe(true);

        const persistedRun = await one(
          'select status from workflow_runs where id = ?',
          run.id
        );
        expect(persistedRun.status).toBe('succeeded');
      }
    }, 120_000);

    async function seedWorkflowRows(
      tableId: string,
      columnId: string,
      targetCount: number
    ) {
      const count = await one(
        'select count(*) as count from rows where table_id = ? and archived_at is null',
        tableId
      );
      const additionalCount = Math.max(0, targetCount - Number(count.count));
      const statements = Array.from({ length: additionalCount }, (_, index) => {
        const rowId = crypto.randomUUID();
        return [
          {
            args: [
              rowId,
              workspaceId!,
              tableId,
              `drain:${String(index).padStart(6, '0')}`,
            ],
            sql: 'insert into rows (id, workspace_id, table_id, position) values (?, ?, ?, ?)',
          },
          {
            args: [
              crypto.randomUUID(),
              workspaceId!,
              tableId,
              rowId,
              columnId,
              `Drain fixture ${index}`,
              `Drain fixture ${index}`,
            ],
            sql: "insert into cells (id, workspace_id, table_id, row_id, column_id, value_type, value_text, search_text) values (?, ?, ?, ?, ?, 'text', ?, ?)",
          },
        ];
      });
      for (let offset = 0; offset < statements.length; offset += 50) {
        await client!.batch(statements.slice(offset, offset + 50).flat());
      }
    }

    async function waitForRunningStep(
      runCollectionUrl: string,
      cookie: string,
      runId: string
    ) {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const response = await fetch(runCollectionUrl, {
          headers: { cookie },
        });
        expect(response.status).toBe(200);
        const runs = (await response.json()) as Array<{
          id: string;
          status: string;
          steps: Array<{ status: string }>;
        }>;
        const run = runs.find((candidate) => candidate.id === runId);
        if (run?.steps.some((step) => step.status === 'running')) return;
        if (
          run?.status === 'succeeded' ||
          run?.status === 'failed' ||
          run?.status === 'cancelled'
        ) {
          throw new Error(
            `Workflow run ${runId} reached ${run.status} before the drain signal.`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        `Workflow run ${runId} did not expose a running step within 20 seconds.`
      );
    }

    async function waitForTerminalRun(
      runCollectionUrl: string,
      cookie: string,
      runId: string
    ) {
      const deadline = Date.now() + (drainDrillRows === null ? 20_000 : 90_000);
      while (Date.now() < deadline) {
        const response = await fetch(runCollectionUrl, {
          headers: { cookie },
        });
        expect(response.status).toBe(200);
        const runs = (await response.json()) as Array<{
          id: string;
          status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
          steps: Array<{ status: string }>;
        }>;
        const run = runs.find((candidate) => candidate.id === runId);
        if (run?.status === 'succeeded') return run;
        if (run?.status === 'failed' || run?.status === 'cancelled') {
          throw new Error(`Workflow run ${runId} ended as ${run.status}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(
        `Workflow run ${runId} did not finish before the verification deadline.`
      );
    }

    async function one(sql: string, argument: string) {
      const result = await client!.execute({ args: [argument], sql });
      const row = result.rows[0];
      if (!row) throw new Error(`Missing SQLite fixture for ${sql}`);
      return row;
    }
  }
);

function parseDrainDrillRows(value: string | undefined): number | null {
  if (value === undefined) return null;
  const rows = Number(value);
  if (!Number.isInteger(rows) || rows < 2 || rows > 500) {
    throw new Error(
      'WORKFLOW_DRAIN_DRILL_ROWS must be an integer from 2 to 500.'
    );
  }
  return rows;
}

function expectSecurityHeaders(headers: Headers): string {
  const policy = headers.get('content-security-policy');
  expect(policy).toContain("frame-ancestors 'none'");
  const scriptDirective = policy
    ?.split('; ')
    .find((directive) => directive.startsWith('script-src '));
  expect(scriptDirective).toContain("'strict-dynamic'");
  expect(scriptDirective).not.toContain("'unsafe-inline'");
  expect(scriptDirective).not.toContain("'unsafe-eval'");
  const nonce = scriptDirective?.match(/'nonce-([^']+)'/u)?.[1];
  expect(nonce).toBeTruthy();
  expect(headers.get('strict-transport-security')).toBe('max-age=31536000');
  expect(headers.get('x-content-type-options')).toBe('nosniff');
  expect(headers.get('x-frame-options')).toBe('DENY');
  expect(headers.get('referrer-policy')).toBe('no-referrer');
  expect(headers.get('permissions-policy')).toBe(
    'camera=(), microphone=(), geolocation=(), browsing-topics=()'
  );
  expect(headers.has('x-powered-by')).toBe(false);
  return nonce!;
}

function expectRenderedScriptNonces(html: string, nonce: string): void {
  const scripts = html.match(/<script\b[^>]*>/giu) ?? [];
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) {
    expect(script.match(/\bnonce="([^"]+)"/iu)?.[1]).toBe(nonce);
  }
}
