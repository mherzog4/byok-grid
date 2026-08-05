import {
  createSqliteGridRow,
  createSqliteWorkflow,
  createSqliteWorkflowRun,
  createSqliteWorkspaceTable,
  migrateSqliteDatabase,
  openSqliteDatabase,
  publishSqliteWorkflow,
  selectSqliteWorkflowRowBatch,
  writeSqliteGridCell,
  type SqliteDatabaseHandle,
} from '@byok-grid/db';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..'
);
const userId = '00000000-0000-4000-8000-000000000501';
const workspaceId = '00000000-0000-4000-8000-000000000502';

describe('SQLite-native workflow worker', () => {
  let child: ChildProcess | undefined;
  let databasePath: string;
  let handle: SqliteDatabaseHandle;
  let output = '';

  beforeEach(async () => {
    databasePath = join(
      tmpdir(),
      `byok-grid-local-worker-${randomUUID()}.sqlite`
    );
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    await handle.client.executeMultiple(`
      insert into users (id, email, name)
        values ('${userId}', 'local-worker@example.test', 'Local Worker Owner');
      insert into workspaces (id, name, slug)
        values ('${workspaceId}', 'Local Worker', 'local-worker');
      insert into workspace_members (workspace_id, user_id, role)
        values ('${workspaceId}', '${userId}', 'owner');
    `);
  });

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await waitForExit(child);
    }
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('executes a durable workflow without Hatchet configuration', async () => {
    const source = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Company',
      firstColumnValueType: 'text',
      name: 'Prospects',
      userId,
      workspaceId,
    });
    const target = await createSqliteWorkspaceTable(handle.db, {
      firstColumnName: 'Company',
      firstColumnValueType: 'text',
      name: 'Qualified',
      userId,
      workspaceId,
    });
    const row = await createSqliteGridRow(handle.db, {
      tableId: source.id,
      userId,
      workspaceId,
    });
    await writeSqliteGridCell(handle.db, {
      columnId: source.firstColumn.id,
      expectedVersion: 0,
      rowId: row.id,
      tableId: source.id,
      userId,
      value: { type: 'text', value: 'Acme' },
      workspaceId,
    });

    const triggerId = randomUUID();
    const destinationId = randomUUID();
    const workflow = await createSqliteWorkflow(handle.db, {
      graph: {
        edges: [
          {
            id: randomUUID(),
            sourceHandle: 'rows',
            sourceNodeId: triggerId,
            targetHandle: 'rows',
            targetNodeId: destinationId,
          },
        ],
        nodes: [
          {
            configuration: {
              searchQuery: null,
              tableId: source.id,
              viewId: null,
            },
            id: triggerId,
            kind: 'trigger.table_rows',
            name: 'All prospects',
            position: { x: 0, y: 0 },
          },
          {
            configuration: {
              columnMappings: [
                {
                  sourceColumnId: source.firstColumn.id,
                  targetColumnId: target.firstColumn.id,
                },
              ],
              tableId: target.id,
            },
            id: destinationId,
            kind: 'destination.write_table',
            name: 'Write qualified',
            position: { x: 300, y: 0 },
          },
        ],
        schemaVersion: 1,
        viewport: { x: 0, y: 0, zoom: 1 },
      },
      name: 'Local execution proof',
      userId,
      workspaceId,
    });
    await publishSqliteWorkflow(handle.db, {
      expectedRevision: workflow.draftRevision,
      userId,
      workflowId: workflow.id,
      workspaceId,
    });
    const run = await createSqliteWorkflowRun(handle.db, {
      userId,
      workflowId: workflow.id,
      workspaceId,
    });
    const poisonEventId = randomUUID();
    await handle.client.execute({
      args: [poisonEventId, workspaceId, randomUUID()],
      sql: `
        insert into outbox_events (
          id, workspace_id, aggregate_type, aggregate_id, event_type, payload,
          dispatch_attempts
        ) values (?, ?, 'bulk_run', ?, 'column.bulk_run_requested', '{}', 4)
      `,
    });

    const metricsPort = await availablePort();
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'apps/workflow-worker/src/index.ts'],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          BYOK_GRID_DATABASE_MODE: 'local',
          BYOK_GRID_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
          BYOK_GRID_MASTER_KEY_ID: 'test-v1',
          BYOK_GRID_METRICS_ENABLED: 'true',
          BYOK_GRID_METRICS_PORT: String(metricsPort),
          HATCHET_CLIENT_API_URL: '',
          HATCHET_CLIENT_HOST_PORT: '',
          HATCHET_CLIENT_TOKEN: '',
          SOURCE_SCHEDULER_POLL_SECONDS: '300',
          SQLITE_AUTH_TOKEN: '',
          SQLITE_DATABASE_URL: `file:${databasePath}`,
          WORKFLOW_DISPATCH_POLL_MS: '100',
          WORKFLOW_EXECUTION_DRIVER: 'local',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    child.stdout?.on('data', appendOutput);
    child.stderr?.on('data', appendOutput);

    await waitForHealthy(metricsPort, child, () => output);
    await waitForRunStatus(run.id, 'succeeded');
    await waitForOutboxCompletion(poisonEventId);
    expect(
      await selectSqliteWorkflowRowBatch(handle.db, {
        searchQuery: null,
        tableId: target.id,
        userId,
        viewId: null,
        workspaceId,
      })
    ).toMatchObject({
      rows: [expect.objectContaining({ tableId: target.id })],
    });

    child.kill('SIGTERM');
    const exit = await waitForExit(child);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(output).toContain('BYOK_GRID_LOCAL_WORKER_DRAIN_COMPLETE');
    expect(output).toContain('Local workflow task reached a terminal failure');
  }, 30_000);

  function appendOutput(chunk: unknown) {
    output = `${output}${String(chunk)}`.slice(-8_000);
  }

  async function waitForRunStatus(runId: string, expected: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await handle.client.execute({
        args: [runId],
        sql: 'select status from workflow_runs where id = ?',
      });
      const status = result.rows[0]?.status;
      if (status === expected) return;
      if (status === 'failed' || status === 'cancelled') {
        throw new Error(
          `The local workflow ended as ${String(status)}.\n${output}`
        );
      }
      await delay(50);
    }
    throw new Error(`The local workflow did not finish.\n${output}`);
  }

  async function waitForOutboxCompletion(eventId: string) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await handle.client.execute({
        args: [eventId],
        sql: 'select published_at from outbox_events where id = ?',
      });
      const row = result.rows[0];
      if (row && row.published_at !== null) return;
      await delay(50);
    }
    throw new Error(`The poison outbox event kept retrying.\n${output}`);
  }
});

async function waitForHealthy(
  port: number,
  processHandle: ChildProcess,
  readOutput: () => string
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // The worker has not opened its health listener yet.
    }
    await delay(50);
  }
  throw new Error(
    `The local workflow worker did not become healthy (exit=${String(processHandle.exitCode)}, signal=${String(processHandle.signalCode)}).\n${readOutput()}`
  );
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Could not reserve a local worker port.');
  }
  await new Promise<void>((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise()))
  );
  return address.port;
}

function waitForExit(
  processHandle: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (processHandle.exitCode !== null || processHandle.signalCode !== null) {
    return Promise.resolve({
      code: processHandle.exitCode,
      signal: processHandle.signalCode,
    });
  }
  return new Promise((resolvePromise) =>
    processHandle.once('exit', (code, signal) =>
      resolvePromise({ code, signal })
    )
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) =>
    setTimeout(resolvePromise, milliseconds)
  );
}
