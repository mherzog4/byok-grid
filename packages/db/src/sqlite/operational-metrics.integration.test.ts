import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteDatabase, type SqliteDatabaseHandle } from './client';
import { migrateSqliteDatabase } from './migrate';
import {
  collectSqliteOperationalMetrics,
  OPERATIONAL_METRICS_WINDOW_SECONDS,
} from './operational-metrics';

const now = new Date('2030-01-01T12:00:00.000Z');
const nowMilliseconds = now.getTime();
const digest = 'a'.repeat(64);

describe('SQLite operational metrics', () => {
  let handle: SqliteDatabaseHandle;

  beforeEach(async () => {
    handle = await openSqliteDatabase({ url: ':memory:' });
    await migrateSqliteDatabase(handle.db);
  });

  afterEach(() => handle.close());

  it('returns a complete zero snapshot for an idle deployment', async () => {
    await expect(
      collectSqliteOperationalMetrics(handle.client, now)
    ).resolves.toEqual({
      activeWorkflowStepOldestAgeSeconds: { ready: 0, running: 0 },
      activeWorkflowSteps: { ready: 0, running: 0 },
      observedAtEpochSeconds: nowMilliseconds / 1_000,
      oldestQueuedWorkflowAgeSeconds: 0,
      oldestUnpublishedOutboxAgeSeconds: 0,
      recentTerminalWorkflowRuns: {
        cancelled: 0,
        failed: 0,
        succeeded: 0,
      },
      terminalWindowSeconds: OPERATIONAL_METRICS_WINDOW_SECONDS,
      unpublishedOutboxEvents: 0,
      workflowRuns: {
        cancelled: 0,
        failed: 0,
        queued: 0,
        running: 0,
        succeeded: 0,
      },
    });
  });

  it('reports low-cardinality queue, terminal, step, and outbox state', async () => {
    await seedOperationalState(handle);

    const snapshot = await collectSqliteOperationalMetrics(handle.client, now);

    expect(snapshot.workflowRuns).toEqual({
      cancelled: 1,
      failed: 1,
      queued: 1,
      running: 1,
      succeeded: 1,
    });
    expect(snapshot.recentTerminalWorkflowRuns).toEqual({
      cancelled: 0,
      failed: 1,
      succeeded: 1,
    });
    expect(snapshot.oldestQueuedWorkflowAgeSeconds).toBe(45);
    expect(snapshot.activeWorkflowSteps).toEqual({ ready: 1, running: 1 });
    expect(snapshot.activeWorkflowStepOldestAgeSeconds).toEqual({
      ready: 30,
      running: 20,
    });
    expect(snapshot.unpublishedOutboxEvents).toBe(1);
    expect(snapshot.oldestUnpublishedOutboxAgeSeconds).toBe(35);
    expect(JSON.stringify(snapshot)).not.toContain('workspace-metrics');
  });
});

async function seedOperationalState(handle: SqliteDatabaseHandle) {
  await handle.client.executeMultiple(`
    insert into users (id, email, name, created_at, updated_at)
      values ('user-metrics', 'metrics@example.test', 'Metrics Owner', ${nowMilliseconds}, ${nowMilliseconds});
    insert into workspaces (id, name, slug, created_at, updated_at)
      values ('workspace-metrics', 'Metrics', 'metrics', ${nowMilliseconds}, ${nowMilliseconds});
    insert into workflows (
      id, workspace_id, name, state, draft_graph, draft_digest,
      published_version, draft_revision, created_by_user_id, created_at, updated_at
    ) values (
      'workflow-metrics', 'workspace-metrics', 'Metrics workflow', 'active',
      '{}', '${digest}', 1, 1, 'user-metrics', ${nowMilliseconds}, ${nowMilliseconds}
    );
    insert into workflow_versions (
      id, workspace_id, workflow_id, version, graph, graph_digest,
      compiled_plan, created_by_user_id, published_at, created_at
    ) values (
      'workflow-version-metrics', 'workspace-metrics', 'workflow-metrics', 1,
      '{}', '${digest}', '{}', 'user-metrics', ${nowMilliseconds}, ${nowMilliseconds}
    );

    insert into workflow_runs (
      id, workspace_id, workflow_id, workflow_version, graph_digest, status,
      input, created_at, updated_at
    ) values
      ('run-queued', 'workspace-metrics', 'workflow-metrics', 1, '${digest}', 'queued', '{}', ${nowMilliseconds - 45_000}, ${nowMilliseconds - 45_000}),
      ('run-running', 'workspace-metrics', 'workflow-metrics', 1, '${digest}', 'running', '{}', ${nowMilliseconds - 40_000}, ${nowMilliseconds - 20_000}),
      ('run-succeeded', 'workspace-metrics', 'workflow-metrics', 1, '${digest}', 'succeeded', '{}', ${nowMilliseconds - 180_000}, ${nowMilliseconds - 60_000}),
      ('run-failed', 'workspace-metrics', 'workflow-metrics', 1, '${digest}', 'failed', '{}', ${nowMilliseconds - 240_000}, ${nowMilliseconds - 120_000}),
      ('run-cancelled', 'workspace-metrics', 'workflow-metrics', 1, '${digest}', 'cancelled', '{}', ${nowMilliseconds - 900_000}, ${nowMilliseconds - 600_000});

    insert into workflow_step_runs (
      run_id, workspace_id, step_id, step_kind, status, attempt, created_at, updated_at
    ) values
      ('run-queued', 'workspace-metrics', 'step-ready', 'logic.filter', 'ready', 0, ${nowMilliseconds - 30_000}, ${nowMilliseconds - 30_000}),
      ('run-running', 'workspace-metrics', 'step-running', 'logic.filter', 'running', 1, ${nowMilliseconds - 25_000}, ${nowMilliseconds - 20_000});

    insert into outbox_events (
      id, workspace_id, aggregate_type, aggregate_id, event_type, payload,
      created_at, published_at
    ) values
      ('outbox-pending', 'workspace-metrics', 'workflow_run', 'run-queued', 'workflow.run_requested', '{}', ${nowMilliseconds - 35_000}, null),
      ('outbox-published', 'workspace-metrics', 'workflow_run', 'run-succeeded', 'workflow.run_requested', '{}', ${nowMilliseconds - 100_000}, ${nowMilliseconds - 90_000}),
      ('outbox-analytics-only', 'workspace-metrics', 'csv_import', 'import-finished', 'table.csv_import_succeeded', '{}', ${nowMilliseconds - 500_000}, null);
  `);
}
