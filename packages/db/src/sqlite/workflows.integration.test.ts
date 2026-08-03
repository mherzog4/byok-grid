import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  createSqliteWorkflow,
  getSqliteWorkflow,
  publishSqliteWorkflow,
  SqliteWorkflowAccessError,
  SqliteWorkflowConflictError,
  updateSqliteWorkflowDraft,
} from './workflows';

const userA = '00000000-0000-4000-8000-000000000001';
const userB = '00000000-0000-4000-8000-000000000002';
const workspaceA = '00000000-0000-4000-8000-000000000011';
const workspaceB = '00000000-0000-4000-8000-000000000012';
const triggerId = '00000000-0000-4000-8000-000000000021';
const destinationNodeId = '00000000-0000-4000-8000-000000000022';

function graph(searchQuery: string | null = null) {
  return {
    edges: [
      {
        id: '00000000-0000-4000-8000-000000000031',
        sourceHandle: 'rows',
        sourceNodeId: triggerId,
        targetHandle: 'rows',
        targetNodeId: destinationNodeId,
      },
    ],
    nodes: [
      {
        configuration: {
          searchQuery,
          tableId: '00000000-0000-4000-8000-000000000041',
          viewId: null,
        },
        id: triggerId,
        kind: 'trigger.table_rows',
        name: 'Rows',
        position: { x: 0, y: 0 },
      },
      {
        configuration: {
          destinationId: '00000000-0000-4000-8000-000000000042',
        },
        id: destinationNodeId,
        kind: 'destination.send_webhook',
        name: 'Send',
        position: { x: 300, y: 0 },
      },
    ],
    schemaVersion: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
  };
}

describe('SQLite workflow repository', () => {
  let handle: SqliteDatabaseHandle;
  let databasePath: string;

  beforeEach(async () => {
    databasePath = join(tmpdir(), `byok-grid-workflows-${randomUUID()}.sqlite`);
    handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    await migrateSqliteDatabase(handle.db);
    for (const [sql, args] of [
      [
        'insert into users (id, email, name) values (?, ?, ?)',
        [userA, 'a@example.test', 'A'],
      ],
      [
        'insert into users (id, email, name) values (?, ?, ?)',
        [userB, 'b@example.test', 'B'],
      ],
      [
        'insert into workspaces (id, name, slug) values (?, ?, ?)',
        [workspaceA, 'A', 'a'],
      ],
      [
        'insert into workspaces (id, name, slug) values (?, ?, ?)',
        [workspaceB, 'B', 'b'],
      ],
      [
        'insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?)',
        [workspaceA, userA, 'owner'],
      ],
      [
        'insert into workspace_members (workspace_id, user_id, role) values (?, ?, ?)',
        [workspaceB, userB, 'owner'],
      ],
    ] as Array<[string, string[]]>) {
      await handle.client.execute({ args, sql });
    }
  });

  afterEach(() => {
    handle.close();
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  });

  it('creates, updates, and publishes immutable graph versions', async () => {
    const created = await createSqliteWorkflow(handle.db, {
      graph: graph(),
      name: 'Lead routing',
      userId: userA,
      workspaceId: workspaceA,
    });
    expect(created.draftRevision).toBe(1);
    expect(created.draftDigest).toMatch(/^[0-9a-f]{64}$/);

    const updated = await updateSqliteWorkflowDraft(handle.db, {
      expectedRevision: created.draftRevision,
      graph: graph('  ＡＣＭＥ  '),
      name: 'Lead routing',
      userId: userA,
      workflowId: created.id,
      workspaceId: workspaceA,
    });
    expect(updated.draftRevision).toBe(2);
    expect(updated.draftDigest).not.toBe(created.draftDigest);

    const published = await publishSqliteWorkflow(handle.db, {
      expectedRevision: updated.draftRevision,
      userId: userA,
      workflowId: created.id,
      workspaceId: workspaceA,
    });
    expect(published.state).toBe('active');
    expect(published.publishedVersion).toBe(1);

    const versions = await handle.client.execute({
      args: [created.id],
      sql: 'select version, graph_digest, graph, compiled_plan from workflow_versions where workflow_id = ?',
    });
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]?.[0]).toBe(1);
    expect(versions.rows[0]?.[1]).toBe(updated.draftDigest);
    expect(JSON.parse(String(versions.rows[0]?.[2]))).toEqual(
      updated.draftGraph
    );
    const compiledPlan = JSON.parse(String(versions.rows[0]?.[3]));
    expect(compiledPlan).toMatchObject({
      entryStepIds: [triggerId],
      schemaVersion: 1,
      terminalStepIds: [destinationNodeId],
    });
    expect(JSON.stringify(compiledPlan)).not.toContain('position');
  });

  it('rejects stale draft revisions', async () => {
    const created = await createSqliteWorkflow(handle.db, {
      graph: graph(),
      name: 'Revision test',
      userId: userA,
      workspaceId: workspaceA,
    });
    await updateSqliteWorkflowDraft(handle.db, {
      expectedRevision: 1,
      graph: graph('Boston'),
      name: created.name,
      userId: userA,
      workflowId: created.id,
      workspaceId: workspaceA,
    });

    await expect(
      updateSqliteWorkflowDraft(handle.db, {
        expectedRevision: 1,
        graph: graph('Chicago'),
        name: created.name,
        userId: userA,
        workflowId: created.id,
        workspaceId: workspaceA,
      })
    ).rejects.toBeInstanceOf(SqliteWorkflowConflictError);
  });

  it('does not reveal workflows across workspace membership boundaries', async () => {
    const created = await createSqliteWorkflow(handle.db, {
      graph: graph(),
      name: 'Private workflow',
      userId: userA,
      workspaceId: workspaceA,
    });

    await expect(
      getSqliteWorkflow(handle.db, {
        userId: userB,
        workflowId: created.id,
        workspaceId: workspaceA,
      })
    ).rejects.toBeInstanceOf(SqliteWorkflowAccessError);
  });
});

describe('SQLite compiled-workflow migration', () => {
  it('preserves historical versions and leaves their plans explicitly uncompiled', async () => {
    const databasePath = join(
      tmpdir(),
      `byok-grid-workflow-upgrade-${randomUUID()}.sqlite`
    );
    const handle = await openSqliteDatabase({ url: `file:${databasePath}` });
    try {
      const storedGraph = JSON.stringify(graph());
      await handle.client.executeMultiple(`
        create table users (id text primary key not null);
        create table workspaces (id text primary key not null);
        create table workflows (
          id text primary key not null,
          workspace_id text not null,
          unique (id, workspace_id)
        );
        create table workflow_versions (
          id text primary key not null,
          workspace_id text not null references workspaces(id) on delete cascade,
          workflow_id text not null,
          version integer not null,
          graph text not null,
          graph_digest text not null,
          created_by_user_id text references users(id) on delete set null,
          published_at integer not null,
          created_at integer not null,
          foreign key (workflow_id, workspace_id)
            references workflows(id, workspace_id) on delete cascade
        );
        create unique index workflow_versions_workflow_version_unique
          on workflow_versions(workflow_id, version);
        create index workflow_versions_workspace_published_idx
          on workflow_versions(workspace_id, published_at);
        create unique index workflow_versions_id_scope_unique
          on workflow_versions(id, workflow_id, workspace_id);
        insert into users values ('${userA}');
        insert into workspaces values ('${workspaceA}');
        insert into workflows values ('workflow-old', '${workspaceA}');
        insert into workflow_versions values (
          'version-old', '${workspaceA}', 'workflow-old', 1,
          '${storedGraph.replaceAll("'", "''")}', '${'a'.repeat(64)}',
          '${userA}', 1, 1
        );
      `);
      const migration = readFileSync(
        new URL(
          '../../sqlite-migrations/0007_rainy_thundra.sql',
          import.meta.url
        ),
        'utf8'
      ).replaceAll('--> statement-breakpoint', '');
      await handle.client.executeMultiple(migration);

      const result = await handle.client.execute(
        "select id, graph, compiled_plan from workflow_versions where id = 'version-old'"
      );
      expect(result.rows[0]).toMatchObject({
        compiled_plan: null,
        graph: storedGraph,
        id: 'version-old',
      });
    } finally {
      handle.close();
      for (const suffix of ['', '-shm', '-wal']) {
        rmSync(`${databasePath}${suffix}`, { force: true });
      }
    }
  });
});
