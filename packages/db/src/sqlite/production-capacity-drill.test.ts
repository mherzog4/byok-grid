import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrateSqliteDatabase } from './migrate';
import { openSqliteDatabase } from './client';
import { users } from './schema';
import { ensureSqlitePersonalWorkspace } from './workspaces';
import { assertRemoteDrillPreconditions } from './remote-production-drill';
import {
  CAPACITY_DRILL_CONFIRMATION,
  CAPACITY_WORKER_OBSERVATION_SCRIPT,
  ProductionCapacityDrillError,
  assertCapacityThresholds,
  assertSameKubectlContext,
  cleanupCapacityFixture,
  compareCapacityWorkerObservations,
  createCapacityFixture,
  createCapacityWorkflow,
  inspectCapacityWebDeployment,
  inspectCapacityWorkerDeployment,
  inspectCapacityWorkerPods,
  parseCapacityWorkerObservation,
  parseProductionCapacityConfig,
  runCapacityWorkload,
  runMeasuredPhase,
  summarizeCapacitySamples,
  type CapacityWorkloadEvidence,
  type ProductionCapacityConfig,
} from './production-capacity-drill';

const digest = `sha256:${'a'.repeat(64)}`;

describe('production capacity drill', () => {
  it('requires an explicit complete capacity envelope and canonical endpoints', () => {
    const parsed = parseProductionCapacityConfig(capacityEnvironment());
    expect(parsed).toMatchObject({
      appOrigin: 'https://capacity.example.com',
      candidateSha: 'b'.repeat(40),
      databaseUrl: 'libsql://capacity-db.example.com',
      namespace: 'capacity-drill',
      profile: {
        expectedWebReplicas: 2,
        expectedWorkerReplicas: 2,
        gridReadConcurrency: 10,
        gridReadRequests: 100,
        maxGridReadP95Ms: 500,
        maxGridSearchP95Ms: 750,
        maxWorkerWriteRetries: 5,
        maxWorkflowCompletionP95Ms: 30_000,
        maxWorkflowEnqueueP95Ms: 1_000,
        maxWriteP95Ms: 1_000,
        profileName: 'reference-small',
        rowCount: 2_000,
        workflowConcurrency: 2,
        workflowRuns: 4,
        writeConcurrency: 5,
        writeRequests: 50,
      },
      webDeployment: 'byok-grid-web',
      workerDeployment: 'byok-grid-worker',
    });
    expect(() =>
      parseProductionCapacityConfig({
        ...capacityEnvironment(),
        BYOK_GRID_CAPACITY_DRILL_CONFIRM: 'yes',
      })
    ).toThrow(CAPACITY_DRILL_CONFIRMATION);
    for (const appOrigin of [
      'http://capacity.example.com',
      'https://localhost',
      'https://user:password@capacity.example.com',
      'https://capacity.example.com/path',
    ]) {
      expect(() =>
        parseProductionCapacityConfig({
          ...capacityEnvironment(),
          BYOK_GRID_CAPACITY_APP_ORIGIN: appOrigin,
        })
      ).toThrow(/HTTPS origin/u);
    }
    expect(() =>
      parseProductionCapacityConfig({
        ...capacityEnvironment(),
        BYOK_GRID_CAPACITY_WRITE_REQUESTS: '2001',
      })
    ).toThrow(/integer from 25 to 2000/u);
  });

  it('summarizes nearest-rank latency and bounded concurrency deterministically', async () => {
    expect(
      summarizeCapacitySamples(
        Array.from({ length: 100 }, (_, index) => index + 1),
        1_000
      )
    ).toEqual({
      count: 100,
      elapsedMs: 1_000,
      maxMs: 100,
      p50Ms: 50,
      p95Ms: 95,
      p99Ms: 99,
      throughputPerSecond: 100,
    });

    let active = 0;
    let maximumActive = 0;
    const summary = await runMeasuredPhase({
      concurrency: 3,
      execute: async () => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
      },
      operations: 9,
    });
    expect(maximumActive).toBe(3);
    expect(summary.count).toBe(9);
    expect(summary.p95Ms).toBeGreaterThan(0);

    active = 0;
    await expect(
      runMeasuredPhase({
        concurrency: 2,
        execute: async (index) => {
          active += 1;
          try {
            await new Promise((resolve) =>
              setTimeout(resolve, index === 0 ? 1 : 5)
            );
            if (index === 0) throw new Error('fixture failure');
          } finally {
            active -= 1;
          }
        },
        operations: 4,
      })
    ).rejects.toThrow(/measured capacity phase failed/u);
    expect(active).toBe(0);
  });

  it('fails when any measured p95 exceeds its declared threshold', () => {
    const profile = capacityConfig().profile;
    const evidence = evidenceFixture();
    expect(() => assertCapacityThresholds(profile, evidence)).not.toThrow();
    expect(() =>
      assertCapacityThresholds({ ...profile, maxWriteP95Ms: 9 }, evidence)
    ).toThrow(/cell write p95/u);
  });

  it('requires stable digest-pinned web and worker deployments', () => {
    const worker = inspectCapacityWorkerDeployment(
      deploymentFixture('worker', 2),
      2
    );
    expect(worker).toEqual({
      imageDigest: digest,
      selector:
        'app.kubernetes.io/component=worker,app.kubernetes.io/name=byok-grid',
    });
    expect(
      inspectCapacityWebDeployment(deploymentFixture('web', 2), 2)
    ).toMatchObject({ imageDigest: digest });
    expect(() =>
      inspectCapacityWorkerDeployment(
        deploymentFixture('worker', 1, 'ghcr.io/example/worker:latest'),
        1
      )
    ).toThrow(/digest-pinned/u);
    expect(() =>
      inspectCapacityWorkerDeployment(deploymentFixture('worker', 2), 3)
    ).toThrow(/declared replica count/u);
  });

  it('requires ready pods and monotonic contention without restarts', () => {
    const pods = inspectCapacityWorkerPods(workerPodListFixture(2), 2);
    expect(pods).toHaveLength(2);
    const before = pods.map((pod, index) =>
      parseCapacityWorkerObservation(pod, {
        acquisitionExhaustions: 0,
        acquisitionRetries: index,
        healthy: true,
        idle: true,
      })
    );
    const after = pods.map((pod, index) =>
      parseCapacityWorkerObservation(pod, {
        acquisitionExhaustions: 0,
        acquisitionRetries: index + 1,
        healthy: true,
        idle: true,
      })
    );
    expect(compareCapacityWorkerObservations(before, after, 2)).toEqual({
      acquisitionExhaustions: 0,
      acquisitionRetries: 2,
    });
    expect(() => compareCapacityWorkerObservations(before, after, 1)).toThrow(
      /write-retry threshold/u
    );
    expect(() =>
      compareCapacityWorkerObservations(
        before,
        after.map((worker, index) =>
          index === 0 ? { ...worker, restartCount: 1 } : worker
        ),
        2
      )
    ).toThrow(/restarted or was replaced/u);
    expect(() => assertSameKubectlContext('production', 'capacity')).toThrow(
      /does not match/u
    );
  });

  it('extracts authenticated idle and contention state inside the worker pod', () => {
    const metrics = [
      'byok_grid_workflow_runs{status="queued"} 0',
      'byok_grid_workflow_runs{status="running"} 0',
      'byok_grid_workflow_active_steps{status="ready"} 0',
      'byok_grid_workflow_active_steps{status="running"} 0',
      'byok_grid_outbox_unpublished_events 0',
      'byok_grid_sqlite_write_acquisition_events{outcome="retry"} 7',
      'byok_grid_sqlite_write_acquisition_events{outcome="exhausted"} 0',
    ].join('\n');
    const prefix = `
globalThis.fetch = async url => String(url).endsWith('/health')
  ? Response.json({ status: 'HEALTHY', name: 'byok-grid-workflow-worker', actions: ['execute-workflow-run'] })
  : new Response(${JSON.stringify(metrics)});
`;
    const result = spawnSync(
      process.execPath,
      ['--eval', `${prefix}\n${CAPACITY_WORKER_OBSERVATION_SCRIPT}`],
      { encoding: 'utf8' }
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      acquisitionExhaustions: 0,
      acquisitionRetries: 7,
      healthy: true,
      idle: true,
    });
  });

  it('creates, seeds, and exactly cleans an isolated migrated SQLite fixture', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'byok-grid-capacity-test-'));
    const handle = await openSqliteDatabase({
      url: `file:${join(directory, 'capacity.sqlite')}`,
    });
    await migrateSqliteDatabase(handle.db);
    const config = {
      ...capacityConfig(),
      drillEmail: 'fixture@example.test',
      profile: { ...capacityConfig().profile, rowCount: 3 },
    };
    const runId = randomUUID();
    try {
      await assertRemoteDrillPreconditions(handle.client);
      const fetchImpl = (async () => {
        const [user] = await handle.db
          .insert(users)
          .values({
            email: config.drillEmail,
            id: randomUUID(),
            name: 'Capacity Fixture',
          })
          .returning({ id: users.id, name: users.name });
        await ensureSqlitePersonalWorkspace(handle.db, user!);
        return Response.json(
          { user: { id: user!.id } },
          { headers: { 'set-cookie': 'capacity_session=fake; Path=/' } }
        );
      }) as typeof fetch;
      const fixture = await createCapacityFixture({
        client: handle.client,
        config,
        fetchImpl,
        runId,
      });
      expect(fixture.rowIds).toHaveLength(3);
      const rowCount = await handle.client.execute('select count(*) from rows');
      expect(Number(rowCount.rows[0]?.[0])).toBe(3);
      await handle.client.execute(
        "insert into rate_limits (id, key, count, last_request) values ('capacity-rate', 'capacity', 1, 1)"
      );
      await cleanupCapacityFixture(handle.client, fixture);
      await assertRemoteDrillPreconditions(handle.client);
    } finally {
      handle.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('measures HTTPS grid, search, write, enqueue, and durable completion paths', async () => {
    const config = {
      ...capacityConfig(),
      profile: {
        ...capacityConfig().profile,
        gridReadConcurrency: 2,
        gridReadRequests: 6,
        workflowConcurrency: 2,
        workflowRuns: 2,
        writeConcurrency: 2,
        writeRequests: 4,
      },
    };
    const fixture = {
      columnId: randomUUID(),
      cookie: 'capacity_session=fake',
      rowIds: Array.from({ length: 4 }, () => randomUUID()),
      tableId: randomUUID(),
      userId: randomUUID(),
      workspaceId: randomUUID(),
    };
    const runIds: string[] = [];
    const targetTableId = randomUUID();
    const targetColumnId = randomUUID();
    const workflowId = randomUUID();
    const fetchImpl = (async (
      request: string | URL | Request,
      init?: RequestInit
    ) => {
      const url = String(request);
      const method = init?.method ?? 'GET';
      if (url.endsWith('/tables') && method === 'POST') {
        return Response.json(
          { firstColumn: { id: targetColumnId }, id: targetTableId },
          { status: 201 }
        );
      }
      if (url.endsWith('/workflows') && method === 'POST') {
        return Response.json(
          { draftRevision: 1, id: workflowId },
          { status: 201 }
        );
      }
      if (url.endsWith('/publish') && method === 'POST') {
        return Response.json({ publishedVersion: 1 });
      }
      if (url.endsWith('/runs') && method === 'POST') {
        const id = randomUUID();
        runIds.push(id);
        return Response.json({ id, status: 'queued' }, { status: 202 });
      }
      if (url.endsWith('/runs') && method === 'GET') {
        return Response.json(
          runIds.map((id) => ({ id, status: 'succeeded', steps: [] }))
        );
      }
      if (url.includes('/cells/') && method === 'PUT') {
        return Response.json({ version: 2 });
      }
      if (url.includes('/tables/') && method === 'GET') {
        return Response.json({
          pageInfo: { hasMore: true, nextCursor: 'cursor' },
          rows: Array.from({ length: 100 }, () => ({ id: randomUUID() })),
        });
      }
      return Response.json({ error: 'unexpected' }, { status: 500 });
    }) as typeof fetch;

    const workflow = await createCapacityWorkflow({
      config,
      fetchImpl,
      fixture,
    });
    const measured = await runCapacityWorkload({
      config,
      fetchImpl,
      fixture,
      workflow,
    });
    expect(measured.gridRead.count).toBe(6);
    expect(measured.gridSearch.count).toBe(6);
    expect(measured.write.count).toBe(4);
    expect(measured.workflowEnqueue.count).toBe(2);
    expect(measured.workflowCompletion.count).toBe(2);
  });

  it('redacts credentials and endpoints from CLI validation failures', () => {
    const authToken = 'capacity-auth-token-sentinel';
    const originSecret = 'capacity-origin-secret-sentinel';
    const environment = {
      ...capacityEnvironment(),
      BYOK_GRID_CAPACITY_APP_ORIGIN: `https://${originSecret}@capacity.example.com`,
      BYOK_GRID_CAPACITY_DATABASE_AUTH_TOKEN: authToken,
      PATH: process.env.PATH,
    };
    const cliPath = fileURLToPath(
      new URL('./production-capacity-drill-cli.ts', import.meta.url)
    );
    const result = spawnSync(process.execPath, ['--import', 'tsx', cliPath], {
      encoding: 'utf8',
      env: environment,
    });
    expect(result.status).toBe(1);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).not.toContain(authToken);
    expect(output).not.toContain(originSecret);
  });
});

function capacityEnvironment(): NodeJS.ProcessEnv {
  return {
    BYOK_GRID_CAPACITY_APP_ORIGIN: 'https://capacity.example.com',
    BYOK_GRID_CAPACITY_CANDIDATE_SHA: 'b'.repeat(40),
    BYOK_GRID_CAPACITY_DATABASE_AUTH_TOKEN: 'capacity-test-token',
    BYOK_GRID_CAPACITY_DATABASE_URL: 'libsql://capacity-db.example.com',
    BYOK_GRID_CAPACITY_DRILL_CONFIRM: CAPACITY_DRILL_CONFIRMATION,
    BYOK_GRID_CAPACITY_EMAIL: 'capacity@example.com',
    BYOK_GRID_CAPACITY_KUBECTL_CONTEXT: 'capacity-cluster',
    BYOK_GRID_CAPACITY_MAX_READ_P95_MS: '500',
    BYOK_GRID_CAPACITY_MAX_SEARCH_P95_MS: '750',
    BYOK_GRID_CAPACITY_MAX_WORKER_WRITE_RETRIES: '5',
    BYOK_GRID_CAPACITY_MAX_WORKFLOW_COMPLETION_P95_MS: '30000',
    BYOK_GRID_CAPACITY_MAX_WORKFLOW_ENQUEUE_P95_MS: '1000',
    BYOK_GRID_CAPACITY_MAX_WRITE_P95_MS: '1000',
    BYOK_GRID_CAPACITY_NAMESPACE: 'capacity-drill',
    BYOK_GRID_CAPACITY_PROFILE: 'reference-small',
    BYOK_GRID_CAPACITY_READ_CONCURRENCY: '10',
    BYOK_GRID_CAPACITY_READ_REQUESTS: '100',
    BYOK_GRID_CAPACITY_ROWS: '2000',
    BYOK_GRID_CAPACITY_WEB_DEPLOYMENT: 'byok-grid-web',
    BYOK_GRID_CAPACITY_WEB_REPLICAS: '2',
    BYOK_GRID_CAPACITY_WORKER_DEPLOYMENT: 'byok-grid-worker',
    BYOK_GRID_CAPACITY_WORKER_REPLICAS: '2',
    BYOK_GRID_CAPACITY_WORKFLOW_CONCURRENCY: '2',
    BYOK_GRID_CAPACITY_WORKFLOW_RUNS: '4',
    BYOK_GRID_CAPACITY_WRITE_CONCURRENCY: '5',
    BYOK_GRID_CAPACITY_WRITE_REQUESTS: '50',
  };
}

function capacityConfig(): ProductionCapacityConfig {
  return parseProductionCapacityConfig(capacityEnvironment());
}

function evidenceFixture(): CapacityWorkloadEvidence {
  const summary = {
    count: 10,
    elapsedMs: 100,
    maxMs: 12,
    p50Ms: 5,
    p95Ms: 10,
    p99Ms: 12,
    throughputPerSecond: 100,
  };
  return {
    gridRead: summary,
    gridSearch: summary,
    workflowCompletion: summary,
    workflowEnqueue: summary,
    write: summary,
  };
}

function deploymentFixture(
  containerName: 'web' | 'worker',
  replicas: number,
  image = `ghcr.io/example/${containerName}@${digest}`
) {
  return {
    metadata: { generation: 9 },
    spec: {
      replicas,
      selector: {
        matchLabels: {
          'app.kubernetes.io/component': containerName,
          'app.kubernetes.io/name': 'byok-grid',
        },
      },
      template: { spec: { containers: [{ image, name: containerName }] } },
    },
    status: {
      availableReplicas: replicas,
      observedGeneration: 9,
      readyReplicas: replicas,
      replicas,
      updatedReplicas: replicas,
    },
  };
}

function workerPodListFixture(count: number) {
  return {
    items: Array.from({ length: count }, (_, index) => ({
      metadata: { name: `worker-${index}`, uid: `worker-uid-${index}` },
      status: {
        conditions: [{ status: 'True', type: 'Ready' }],
        containerStatuses: [
          {
            name: 'worker',
            ready: true,
            restartCount: 0,
            state: { running: { startedAt: '2026-08-03T00:00:00Z' } },
          },
        ],
        phase: 'Running',
      },
    })),
  };
}
