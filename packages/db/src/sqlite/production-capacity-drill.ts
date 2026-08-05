import { createClient, type Client, type InStatement } from '@libsql/client';
import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';

export const CAPACITY_DRILL_CONFIRMATION =
  'isolated-preproduction-capacity-environment';
export const CAPACITY_DRILL_MARKER = 'BYOK_GRID_PRODUCTION_CAPACITY_VERIFIED';
export const CAPACITY_WORKER_OBSERVATION_SCRIPT = String.raw`
Promise.all([
  fetch('http://127.0.0.1:8001/health').then(async response => ({ ok: response.ok, body: await response.json() })),
  fetch('http://127.0.0.1:8002/metrics').then(async response => ({ ok: response.ok, body: await response.text() })),
]).then(([health, metrics]) => {
  const value = (name, labels = '') => {
    const escaped = (name + labels).replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    const match = metrics.body.match(new RegExp('^' + escaped + ' ([0-9.eE+-]+)$', 'm'));
    return match ? Number(match[1]) : Number.NaN;
  };
  const queued = value('byok_grid_workflow_runs', '{status="queued"}');
  const running = value('byok_grid_workflow_runs', '{status="running"}');
  const readySteps = value('byok_grid_workflow_active_steps', '{status="ready"}');
  const runningSteps = value('byok_grid_workflow_active_steps', '{status="running"}');
  const outbox = value('byok_grid_outbox_unpublished_events');
  const acquisitionRetries = value('byok_grid_sqlite_write_acquisition_events', '{outcome="retry"}');
  const acquisitionExhaustions = value('byok_grid_sqlite_write_acquisition_events', '{outcome="exhausted"}');
  const numbers = [queued, running, readySteps, runningSteps, outbox, acquisitionRetries, acquisitionExhaustions];
  if (!health.ok || !metrics.ok || numbers.some(number => !Number.isFinite(number))) process.exit(1);
  process.stdout.write(JSON.stringify({
    acquisitionExhaustions,
    acquisitionRetries,
    healthy: health.body.status === 'HEALTHY' && health.body.name === 'byok-grid-workflow-worker' && Array.isArray(health.body.actions) && health.body.actions.length > 0,
    idle: queued === 0 && running === 0 && readySteps === 0 && runningSteps === 0 && outbox === 0,
  }));
}).catch(() => process.exit(1));
`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA_PATTERN = /^[0-9a-f]{40}$/u;
const PROFILE_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/u;
const CAPACITY_LOCAL_OWNER = Object.freeze({
  email: 'local-owner@byok-grid.invalid',
  id: 'local-owner',
  name: 'Local owner',
});
const FTS5_SHADOW_SUFFIXES = [
  'config',
  'content',
  'data',
  'docsize',
  'idx',
] as const;

export interface ProductionCapacityProfile {
  expectedWebReplicas: number;
  expectedWorkerReplicas: number;
  gridReadConcurrency: number;
  gridReadRequests: number;
  maxGridReadP95Ms: number;
  maxGridSearchP95Ms: number;
  maxWorkerWriteRetries: number;
  maxWorkflowCompletionP95Ms: number;
  maxWorkflowEnqueueP95Ms: number;
  maxWriteP95Ms: number;
  profileName: string;
  rowCount: number;
  workflowConcurrency: number;
  workflowRuns: number;
  writeConcurrency: number;
  writeRequests: number;
}

export interface ProductionCapacityConfig {
  appOrigin: string;
  candidateSha: string;
  databaseAuthToken: string;
  databaseUrl: string;
  kubectlContext: string;
  namespace: string;
  profile: ProductionCapacityProfile;
  webDeployment: string;
  workerDeployment: string;
}

export interface CapacityPhaseSummary {
  count: number;
  elapsedMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  throughputPerSecond: number;
}

export interface CapacityFixture {
  columnId: string;
  rowIds: string[];
  tableId: string;
  workspaceId: string;
}

export interface CapacityWorkflow {
  runCollectionUrl: string;
}

export interface CapacityWorkloadEvidence {
  gridRead: CapacityPhaseSummary;
  gridSearch: CapacityPhaseSummary;
  workflowCompletion: CapacityPhaseSummary;
  workflowEnqueue: CapacityPhaseSummary;
  write: CapacityPhaseSummary;
}

export interface CapacityWorkerPod {
  name: string;
  restartCount: number;
  uid: string;
}

export interface CapacityWorkerObservation extends CapacityWorkerPod {
  acquisitionExhaustions: number;
  acquisitionRetries: number;
}

export class ProductionCapacityDrillError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ProductionCapacityDrillError';
  }
}

export function parseProductionCapacityConfig(
  environment: NodeJS.ProcessEnv
): ProductionCapacityConfig {
  if (
    environment.BYOK_GRID_CAPACITY_DRILL_CONFIRM !== CAPACITY_DRILL_CONFIRMATION
  ) {
    throw new ProductionCapacityDrillError(
      `Set BYOK_GRID_CAPACITY_DRILL_CONFIRM=${CAPACITY_DRILL_CONFIRMATION} only for an isolated preproduction environment.`
    );
  }

  const rowCount = integer(
    environment,
    'BYOK_GRID_CAPACITY_ROWS',
    500,
    100_000
  );
  const gridReadConcurrency = integer(
    environment,
    'BYOK_GRID_CAPACITY_READ_CONCURRENCY',
    1,
    200
  );
  const gridReadRequests = integer(
    environment,
    'BYOK_GRID_CAPACITY_READ_REQUESTS',
    gridReadConcurrency * 5,
    100_000
  );
  const writeConcurrency = integer(
    environment,
    'BYOK_GRID_CAPACITY_WRITE_CONCURRENCY',
    1,
    100
  );
  const writeRequests = integer(
    environment,
    'BYOK_GRID_CAPACITY_WRITE_REQUESTS',
    writeConcurrency * 5,
    rowCount
  );
  const workflowConcurrency = integer(
    environment,
    'BYOK_GRID_CAPACITY_WORKFLOW_CONCURRENCY',
    1,
    10
  );
  const workflowRuns = integer(
    environment,
    'BYOK_GRID_CAPACITY_WORKFLOW_RUNS',
    workflowConcurrency,
    20
  );

  return {
    appOrigin: canonicalHttpsOrigin(
      required(environment, 'BYOK_GRID_CAPACITY_APP_ORIGIN')
    ),
    candidateSha: pattern(
      environment,
      'BYOK_GRID_CAPACITY_CANDIDATE_SHA',
      SHA_PATTERN,
      'a lowercase 40-character commit SHA'
    ),
    databaseAuthToken: required(
      environment,
      'BYOK_GRID_CAPACITY_DATABASE_AUTH_TOKEN'
    ),
    databaseUrl: canonicalLibsqlUrl(
      required(environment, 'BYOK_GRID_CAPACITY_DATABASE_URL')
    ),
    kubectlContext: boundedText(
      environment,
      'BYOK_GRID_CAPACITY_KUBECTL_CONTEXT',
      253
    ),
    namespace: dnsLabel(environment, 'BYOK_GRID_CAPACITY_NAMESPACE'),
    profile: {
      expectedWebReplicas: integer(
        environment,
        'BYOK_GRID_CAPACITY_WEB_REPLICAS',
        1,
        20
      ),
      expectedWorkerReplicas: integer(
        environment,
        'BYOK_GRID_CAPACITY_WORKER_REPLICAS',
        1,
        20
      ),
      gridReadConcurrency,
      gridReadRequests,
      maxGridReadP95Ms: integer(
        environment,
        'BYOK_GRID_CAPACITY_MAX_READ_P95_MS',
        1,
        60_000
      ),
      maxGridSearchP95Ms: integer(
        environment,
        'BYOK_GRID_CAPACITY_MAX_SEARCH_P95_MS',
        1,
        60_000
      ),
      maxWorkerWriteRetries: integer(
        environment,
        'BYOK_GRID_CAPACITY_MAX_WORKER_WRITE_RETRIES',
        0,
        1_000_000
      ),
      maxWorkflowCompletionP95Ms: integer(
        environment,
        'BYOK_GRID_CAPACITY_MAX_WORKFLOW_COMPLETION_P95_MS',
        1,
        120_000
      ),
      maxWorkflowEnqueueP95Ms: integer(
        environment,
        'BYOK_GRID_CAPACITY_MAX_WORKFLOW_ENQUEUE_P95_MS',
        1,
        60_000
      ),
      maxWriteP95Ms: integer(
        environment,
        'BYOK_GRID_CAPACITY_MAX_WRITE_P95_MS',
        1,
        60_000
      ),
      profileName: pattern(
        environment,
        'BYOK_GRID_CAPACITY_PROFILE',
        PROFILE_PATTERN,
        'a lowercase profile slug'
      ),
      rowCount,
      workflowConcurrency,
      workflowRuns,
      writeConcurrency,
      writeRequests,
    },
    webDeployment: dnsSubdomain(
      environment,
      'BYOK_GRID_CAPACITY_WEB_DEPLOYMENT'
    ),
    workerDeployment: dnsSubdomain(
      environment,
      'BYOK_GRID_CAPACITY_WORKER_DEPLOYMENT'
    ),
  };
}

export function openProductionCapacityClient(
  config: Pick<ProductionCapacityConfig, 'databaseAuthToken' | 'databaseUrl'>
): Client {
  return createClient({
    authToken: config.databaseAuthToken,
    timeout: 5_000,
    url: config.databaseUrl,
  });
}

export async function createCapacityFixture(input: {
  client: Client;
  config: ProductionCapacityConfig;
  fetchImpl?: typeof fetch;
  runId: string;
}): Promise<CapacityFixture> {
  return safely('fixture creation', async () => {
    const fetchImpl = input.fetchImpl ?? fetch;
    const response = await safeFetch(
      fetchImpl,
      `${input.config.appOrigin}/app`,
      {
        headers: { origin: input.config.appOrigin },
      }
    );
    requireStatus(
      response,
      200,
      'The capacity fixture could not open the local workspace.'
    );

    const user = await one(input.client, 'select id from users where id = ?', [
      CAPACITY_LOCAL_OWNER.id,
    ]);
    const workspace = await one(
      input.client,
      'select workspace_id from workspace_members where user_id = ?',
      [String(user.id)]
    );
    const table = await one(
      input.client,
      'select id from data_tables where workspace_id = ? order by created_at limit 1',
      [String(workspace.workspace_id)]
    );
    const column = await one(
      input.client,
      "select id from columns where table_id = ? and kind = 'input' order by position limit 1",
      [String(table.id)]
    );
    const rowIds = await seedRows(input.client, {
      columnId: String(column.id),
      rowCount: input.config.profile.rowCount,
      runId: input.runId,
      tableId: String(table.id),
      workspaceId: String(workspace.workspace_id),
    });

    return {
      columnId: String(column.id),
      rowIds,
      tableId: String(table.id),
      workspaceId: String(workspace.workspace_id),
    };
  });
}

export async function createCapacityWorkflow(input: {
  config: ProductionCapacityConfig;
  fetchImpl?: typeof fetch;
  fixture: CapacityFixture;
}): Promise<CapacityWorkflow> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const tableCollectionUrl = `${input.config.appOrigin}/api/workspaces/${input.fixture.workspaceId}/tables`;
  const targetResponse = await capacityJson(fetchImpl, tableCollectionUrl, {
    body: JSON.stringify({
      firstColumnName: 'Capacity output',
      firstColumnValueType: 'text',
      name: 'Capacity workflow output',
    }),
    expectedStatus: 201,
    method: 'POST',
    origin: input.config.appOrigin,
    phase: 'workflow target creation',
  });
  const targetTableId = uuidField(
    targetResponse,
    'id',
    'workflow target table'
  );
  const targetFirstColumn = objectField(
    object(targetResponse, 'workflow target table'),
    'firstColumn',
    'workflow target column'
  );
  const targetColumnId = uuidField(
    targetFirstColumn,
    'id',
    'workflow target column'
  );

  const triggerId = randomUUID();
  const destinationId = randomUUID();
  const workflowCollectionUrl = `${input.config.appOrigin}/api/workspaces/${input.fixture.workspaceId}/workflows`;
  const workflowResponse = await capacityJson(
    fetchImpl,
    workflowCollectionUrl,
    {
      body: JSON.stringify({
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
                tableId: input.fixture.tableId,
                viewId: null,
              },
              id: triggerId,
              kind: 'trigger.table_rows',
              name: 'Capacity rows',
              position: { x: 0, y: 0 },
            },
            {
              configuration: {
                columnMappings: [
                  {
                    sourceColumnId: input.fixture.columnId,
                    targetColumnId,
                  },
                ],
                tableId: targetTableId,
              },
              id: destinationId,
              kind: 'destination.write_table',
              name: 'Capacity output',
              position: { x: 300, y: 0 },
            },
          ],
          schemaVersion: 1,
          viewport: { x: 0, y: 0, zoom: 1 },
        },
        name: 'Production capacity workflow',
      }),
      expectedStatus: 201,
      method: 'POST',
      origin: input.config.appOrigin,
      phase: 'workflow creation',
    }
  );
  const workflowId = uuidField(workflowResponse, 'id', 'capacity workflow');
  const draftRevision = integerField(
    object(workflowResponse, 'capacity workflow'),
    'draftRevision',
    'capacity workflow'
  );
  await capacityJson(
    fetchImpl,
    `${workflowCollectionUrl}/${workflowId}/publish`,
    {
      body: JSON.stringify({ expectedRevision: draftRevision }),
      expectedStatus: 200,
      method: 'POST',
      origin: input.config.appOrigin,
      phase: 'workflow publication',
    }
  );
  return { runCollectionUrl: `${workflowCollectionUrl}/${workflowId}/runs` };
}

export async function runCapacityWorkload(input: {
  config: ProductionCapacityConfig;
  fetchImpl?: typeof fetch;
  fixture: CapacityFixture;
  workflow: CapacityWorkflow;
}): Promise<CapacityWorkloadEvidence> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const tableUrl = `${input.config.appOrigin}/api/workspaces/${input.fixture.workspaceId}/tables/${input.fixture.tableId}`;
  const requestHeaders = {};

  for (let index = 0; index < 5; index += 1) {
    await performGridRead(fetchImpl, `${tableUrl}?limit=100`, requestHeaders);
  }

  const gridRead = await runMeasuredPhase({
    concurrency: input.config.profile.gridReadConcurrency,
    execute: (_, signal) =>
      performGridRead(
        fetchImpl,
        `${tableUrl}?limit=100`,
        requestHeaders,
        signal
      ),
    operations: input.config.profile.gridReadRequests,
  });
  const gridSearch = await runMeasuredPhase({
    concurrency: input.config.profile.gridReadConcurrency,
    execute: (_, signal) =>
      performGridRead(
        fetchImpl,
        `${tableUrl}?limit=100&search=Capacity%20fixture`,
        requestHeaders,
        signal
      ),
    operations: input.config.profile.gridReadRequests,
  });

  const write = await runMeasuredPhase({
    concurrency: input.config.profile.writeConcurrency,
    execute: async (index, signal) => {
      const response = await safeFetch(
        fetchImpl,
        `${tableUrl}/rows/${input.fixture.rowIds[index]}/cells/${input.fixture.columnId}`,
        {
          body: JSON.stringify({
            expectedVersion: 1,
            value: { type: 'text', value: `Capacity measured ${index}` },
          }),
          headers: {
            'content-type': 'application/json',
            origin: input.config.appOrigin,
          },
          method: 'PUT',
          signal,
        }
      );
      requireStatus(response, 200, 'A measured cell write failed.');
      const body = await safeJson(
        response,
        'A measured cell response was malformed.'
      );
      if (
        integerField(
          object(body, 'measured cell'),
          'version',
          'measured cell'
        ) !== 2
      ) {
        throw new ProductionCapacityDrillError(
          'A measured cell write returned an unexpected version.'
        );
      }
    },
    operations: input.config.profile.writeRequests,
  });

  const runStartedAt = new Map<string, number>();
  const workflowEnqueue = await runMeasuredPhase({
    concurrency: input.config.profile.workflowConcurrency,
    execute: async (index, signal) => {
      const startedAt = performance.now();
      const response = await safeFetch(
        fetchImpl,
        input.workflow.runCollectionUrl,
        {
          body: JSON.stringify({ input: { capacityOperation: index } }),
          headers: {
            'content-type': 'application/json',
            origin: input.config.appOrigin,
          },
          method: 'POST',
          signal,
        }
      );
      requireStatus(response, 202, 'A measured workflow enqueue failed.');
      const body = await safeJson(
        response,
        'A measured workflow enqueue response was malformed.'
      );
      const runId = uuidField(body, 'id', 'workflow enqueue');
      runStartedAt.set(runId, startedAt);
    },
    operations: input.config.profile.workflowRuns,
  });
  const workflowCompletion = await waitForWorkflowRuns({
    fetchImpl,
    runCollectionUrl: input.workflow.runCollectionUrl,
    runStartedAt,
  });

  const evidence = {
    gridRead,
    gridSearch,
    workflowCompletion,
    workflowEnqueue,
    write,
  };
  assertCapacityThresholds(input.config.profile, evidence);
  return evidence;
}

export async function cleanupCapacityFixture(
  client: Client,
  fixture: Pick<CapacityFixture, 'workspaceId'>
): Promise<void> {
  await safely('fixture cleanup', async () => {
    await client.batch(
      [
        {
          args: [fixture.workspaceId],
          sql: 'delete from workspaces where id = ?',
        },
        { sql: 'delete from rate_limits' },
      ],
      'write'
    );
  });
}

export async function assertCapacityCleanupState(
  client: Client
): Promise<void> {
  await safely('cleanup verification', async () => {
    const owners = await client.execute(
      'select id, email, name from users order by id'
    );
    if (
      owners.rows.length !== 1 ||
      owners.rows[0]?.[0] !== CAPACITY_LOCAL_OWNER.id ||
      owners.rows[0]?.[1] !== CAPACITY_LOCAL_OWNER.email ||
      owners.rows[0]?.[2] !== CAPACITY_LOCAL_OWNER.name
    ) {
      throw new ProductionCapacityDrillError(
        'Capacity cleanup did not preserve exactly the deterministic local owner.'
      );
    }

    const tables = await client.execute(
      `select name, coalesce(sql, '') from sqlite_schema
        where type = 'table' and name not like 'sqlite_%'
        order by name asc`
    );
    const fullTextTables = tables.rows
      .filter(
        (row) =>
          typeof row[0] === 'string' &&
          typeof row[1] === 'string' &&
          /\busing\s+fts5\b/iu.test(row[1])
      )
      .map((row) => row[0] as string);
    const fullTextShadowTables = new Set(
      fullTextTables.flatMap((name) =>
        FTS5_SHADOW_SUFFIXES.map((suffix) => `${name}_${suffix}`)
      )
    );

    for (const row of tables.rows) {
      const name = row[0];
      if (typeof name !== 'string') {
        throw new ProductionCapacityDrillError(
          'Capacity cleanup found an invalid table name.'
        );
      }
      if (
        name === '__drizzle_migrations' ||
        name === 'users' ||
        fullTextShadowTables.has(name)
      ) {
        continue;
      }
      const count = await client.execute(
        `select count(*) from ${quoteIdentifier(name)}`
      );
      if (Number(count.rows[0]?.[0] ?? 0) !== 0) {
        throw new ProductionCapacityDrillError(
          'Capacity cleanup left application rows behind.'
        );
      }
    }
  });
}

export function summarizeCapacitySamples(
  samples: readonly number[],
  elapsedMs: number
): CapacityPhaseSummary {
  if (samples.length === 0 || elapsedMs <= 0 || !Number.isFinite(elapsedMs)) {
    throw new ProductionCapacityDrillError(
      'Capacity samples require positive finite observations and elapsed time.'
    );
  }
  const sorted = [...samples].sort((left, right) => left - right);
  if (sorted.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new ProductionCapacityDrillError(
      'Capacity latency samples must be finite and nonnegative.'
    );
  }
  return {
    count: sorted.length,
    elapsedMs: rounded(elapsedMs),
    maxMs: rounded(sorted.at(-1)!),
    p50Ms: rounded(percentile(sorted, 0.5)),
    p95Ms: rounded(percentile(sorted, 0.95)),
    p99Ms: rounded(percentile(sorted, 0.99)),
    throughputPerSecond: rounded((sorted.length * 1_000) / elapsedMs),
  };
}

export async function runMeasuredPhase(input: {
  concurrency: number;
  execute: (index: number, signal: AbortSignal) => Promise<void>;
  operations: number;
}): Promise<CapacityPhaseSummary> {
  if (
    !Number.isInteger(input.concurrency) ||
    input.concurrency < 1 ||
    !Number.isInteger(input.operations) ||
    input.operations < input.concurrency
  ) {
    throw new ProductionCapacityDrillError(
      'A measured phase requires positive operations and bounded concurrency.'
    );
  }
  const controller = new AbortController();
  const samples = new Array<number>(input.operations);
  let nextIndex = 0;
  const phaseStartedAt = performance.now();
  const workers = Array.from({ length: input.concurrency }, async () => {
    for (;;) {
      if (controller.signal.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= input.operations) return;
      const startedAt = performance.now();
      try {
        await input.execute(index, controller.signal);
        samples[index] = performance.now() - startedAt;
      } catch (error) {
        controller.abort();
        throw error;
      }
    }
  });
  const results = await Promise.allSettled(workers);
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failure) {
    if (failure.reason instanceof ProductionCapacityDrillError) {
      throw failure.reason;
    }
    throw new ProductionCapacityDrillError('A measured capacity phase failed.');
  }
  return summarizeCapacitySamples(samples, performance.now() - phaseStartedAt);
}

export function assertCapacityThresholds(
  profile: ProductionCapacityProfile,
  evidence: CapacityWorkloadEvidence
): void {
  const checks = [
    ['grid read', evidence.gridRead.p95Ms, profile.maxGridReadP95Ms],
    ['grid search', evidence.gridSearch.p95Ms, profile.maxGridSearchP95Ms],
    ['cell write', evidence.write.p95Ms, profile.maxWriteP95Ms],
    [
      'workflow enqueue',
      evidence.workflowEnqueue.p95Ms,
      profile.maxWorkflowEnqueueP95Ms,
    ],
    [
      'workflow completion',
      evidence.workflowCompletion.p95Ms,
      profile.maxWorkflowCompletionP95Ms,
    ],
  ] as const;
  for (const [name, actual, maximum] of checks) {
    if (actual > maximum) {
      throw new ProductionCapacityDrillError(
        `The measured ${name} p95 exceeded the declared capacity threshold.`
      );
    }
  }
}

export function inspectCapacityWorkerDeployment(
  value: unknown,
  expectedReplicas: number
): { imageDigest: string; selector: string } {
  return inspectCapacityDeployment(value, expectedReplicas, 'worker');
}

export function inspectCapacityWebDeployment(
  value: unknown,
  expectedReplicas: number
): { imageDigest: string; selector: string } {
  return inspectCapacityDeployment(value, expectedReplicas, 'web');
}

function inspectCapacityDeployment(
  value: unknown,
  expectedReplicas: number,
  containerName: 'web' | 'worker'
): { imageDigest: string; selector: string } {
  const deployment = object(value, 'worker deployment');
  const metadata = objectField(deployment, 'metadata', 'worker deployment');
  const spec = objectField(deployment, 'spec', 'worker deployment');
  const status = objectField(deployment, 'status', 'worker deployment');
  const selector = objectField(spec, 'selector', 'worker deployment');
  const matchLabels = objectField(selector, 'matchLabels', 'worker deployment');
  const template = objectField(spec, 'template', 'worker deployment');
  const podSpec = objectField(template, 'spec', 'worker deployment');
  if (
    integerField(spec, 'replicas', 'worker deployment') !== expectedReplicas ||
    integerField(status, 'observedGeneration', 'worker deployment') !==
      integerField(metadata, 'generation', 'worker deployment') ||
    integerField(status, 'replicas', 'worker deployment') !==
      expectedReplicas ||
    integerField(status, 'updatedReplicas', 'worker deployment') !==
      expectedReplicas ||
    integerField(status, 'readyReplicas', 'worker deployment') !==
      expectedReplicas ||
    integerField(status, 'availableReplicas', 'worker deployment') !==
      expectedReplicas ||
    (status.unavailableReplicas ?? 0) !== 0
  ) {
    throw new ProductionCapacityDrillError(
      'The worker deployment is not stable at the declared replica count.'
    );
  }
  if (
    Array.isArray(selector.matchExpressions) &&
    selector.matchExpressions.length > 0
  ) {
    throw new ProductionCapacityDrillError(
      'The capacity drill supports worker selectors made only from matchLabels.'
    );
  }
  const entries = Object.entries(matchLabels);
  if (entries.length === 0) {
    throw new ProductionCapacityDrillError(
      'The worker deployment selector has no matchLabels.'
    );
  }
  if (!Array.isArray(podSpec.containers)) {
    throw new ProductionCapacityDrillError(
      'The capacity deployment has malformed containers.'
    );
  }
  const containers = podSpec.containers.filter(
    (candidate) => candidate?.name === containerName
  );
  if (containers.length !== 1) {
    throw new ProductionCapacityDrillError(
      'The capacity deployment does not contain the expected container.'
    );
  }
  const image = stringField(
    object(containers[0], 'capacity container'),
    'image',
    'capacity container'
  );
  const imageMatch = image.match(/^[^\s@]+@(?<digest>sha256:[0-9a-f]{64})$/u);
  if (!imageMatch?.groups?.digest) {
    throw new ProductionCapacityDrillError(
      'Every measured capacity workload must use a digest-pinned image.'
    );
  }
  return {
    imageDigest: imageMatch.groups.digest,
    selector: entries
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${selectorPart(key)}=${selectorPart(value)}`)
      .join(','),
  };
}

export function inspectCapacityWorkerPods(
  value: unknown,
  expectedReplicas: number
): CapacityWorkerPod[] {
  const list = object(value, 'worker pod list');
  if (!Array.isArray(list.items)) {
    throw new ProductionCapacityDrillError(
      'The worker pod list response is malformed.'
    );
  }
  const pods = list.items.filter(
    (candidate) => candidate?.metadata?.deletionTimestamp === undefined
  );
  if (pods.length !== expectedReplicas) {
    throw new ProductionCapacityDrillError(
      'The ready worker pod count does not match the declared replica count.'
    );
  }
  return pods
    .map((candidate) => {
      const pod = object(candidate, 'worker pod');
      const metadata = objectField(pod, 'metadata', 'worker pod');
      const status = objectField(pod, 'status', 'worker pod');
      if (status.phase !== 'Running' || !readyCondition(status.conditions)) {
        throw new ProductionCapacityDrillError(
          'Every capacity worker pod must be running and ready.'
        );
      }
      if (!Array.isArray(status.containerStatuses)) {
        throw new ProductionCapacityDrillError(
          'A capacity worker pod has malformed container state.'
        );
      }
      const matches = status.containerStatuses.filter(
        (container: { name?: unknown }) => container?.name === 'worker'
      );
      if (matches.length !== 1) {
        throw new ProductionCapacityDrillError(
          'Every capacity worker pod needs one worker container.'
        );
      }
      const container = object(matches[0], 'worker container');
      if (
        container.ready !== true ||
        !objectOrUndefined(container.state)?.running
      ) {
        throw new ProductionCapacityDrillError(
          'Every worker container must be running and ready.'
        );
      }
      return {
        name: stringField(metadata, 'name', 'worker pod'),
        restartCount: integerField(
          container,
          'restartCount',
          'worker container'
        ),
        uid: stringField(metadata, 'uid', 'worker pod'),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function parseCapacityWorkerObservation(
  pod: CapacityWorkerPod,
  value: unknown
): CapacityWorkerObservation {
  const observation = object(value, 'worker observation');
  if (observation.healthy !== true || observation.idle !== true) {
    throw new ProductionCapacityDrillError(
      'Every worker must be authenticated, healthy, and idle.'
    );
  }
  return {
    ...pod,
    acquisitionExhaustions: nonnegativeNumberField(
      observation,
      'acquisitionExhaustions',
      'worker observation'
    ),
    acquisitionRetries: nonnegativeNumberField(
      observation,
      'acquisitionRetries',
      'worker observation'
    ),
  };
}

export function compareCapacityWorkerObservations(
  before: readonly CapacityWorkerObservation[],
  after: readonly CapacityWorkerObservation[],
  maximumRetries: number
): { acquisitionExhaustions: number; acquisitionRetries: number } {
  if (before.length !== after.length) {
    throw new ProductionCapacityDrillError(
      'The worker replica set changed during the capacity drill.'
    );
  }
  let acquisitionExhaustions = 0;
  let acquisitionRetries = 0;
  for (const initial of before) {
    const current = after.find((candidate) => candidate.name === initial.name);
    if (
      !current ||
      current.uid !== initial.uid ||
      current.restartCount !== initial.restartCount
    ) {
      throw new ProductionCapacityDrillError(
        'A workflow worker restarted or was replaced during the capacity drill.'
      );
    }
    const exhaustedDelta =
      current.acquisitionExhaustions - initial.acquisitionExhaustions;
    const retryDelta = current.acquisitionRetries - initial.acquisitionRetries;
    if (exhaustedDelta < 0 || retryDelta < 0) {
      throw new ProductionCapacityDrillError(
        'A worker contention counter moved backwards during the capacity drill.'
      );
    }
    acquisitionExhaustions += exhaustedDelta;
    acquisitionRetries += retryDelta;
  }
  if (acquisitionExhaustions !== 0) {
    throw new ProductionCapacityDrillError(
      'The capacity workload exhausted a worker SQLite write acquisition.'
    );
  }
  if (acquisitionRetries > maximumRetries) {
    throw new ProductionCapacityDrillError(
      'The capacity workload exceeded the declared worker write-retry threshold.'
    );
  }
  return { acquisitionExhaustions, acquisitionRetries };
}

export function assertSameKubectlContext(
  actual: string,
  expected: string
): void {
  if (actual.trim() !== expected) {
    throw new ProductionCapacityDrillError(
      'The active kubectl context does not match the declared capacity context.'
    );
  }
}

export function safeProductionCapacityMessage(error: unknown): string {
  return error instanceof ProductionCapacityDrillError
    ? error.message
    : 'The production capacity drill failed unexpectedly.';
}

async function waitForWorkflowRuns(input: {
  fetchImpl: typeof fetch;
  runCollectionUrl: string;
  runStartedAt: ReadonlyMap<string, number>;
}): Promise<CapacityPhaseSummary> {
  const deadline = Date.now() + 120_000;
  const completionSamples = new Map<string, number>();
  while (Date.now() < deadline) {
    const response = await safeFetch(input.fetchImpl, input.runCollectionUrl);
    requireStatus(response, 200, 'Workflow capacity polling failed.');
    const body = await safeJson(
      response,
      'The workflow capacity history response was malformed.'
    );
    if (!Array.isArray(body)) {
      throw new ProductionCapacityDrillError(
        'The workflow capacity history response was malformed.'
      );
    }
    for (const run of body) {
      if (!run || typeof run !== 'object') continue;
      const id = (run as Record<string, unknown>).id;
      if (typeof id !== 'string' || !input.runStartedAt.has(id)) continue;
      const status = (run as Record<string, unknown>).status;
      if (status === 'failed' || status === 'cancelled') {
        throw new ProductionCapacityDrillError(
          'A measured workflow run ended unsuccessfully.'
        );
      }
      if (status === 'succeeded' && !completionSamples.has(id)) {
        completionSamples.set(
          id,
          performance.now() - input.runStartedAt.get(id)!
        );
      }
    }
    if (completionSamples.size === input.runStartedAt.size) {
      const values = [...completionSamples.values()];
      return summarizeCapacitySamples(values, Math.max(...values));
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
  }
  throw new ProductionCapacityDrillError(
    'Measured workflow runs did not complete inside 120 seconds.'
  );
}

async function seedRows(
  client: Client,
  input: {
    columnId: string;
    rowCount: number;
    runId: string;
    tableId: string;
    workspaceId: string;
  }
): Promise<string[]> {
  const rowIds = Array.from({ length: input.rowCount }, () => randomUUID());
  for (let offset = 0; offset < rowIds.length; offset += 50) {
    const statements: InStatement[] = [];
    for (
      let index = offset;
      index < Math.min(offset + 50, rowIds.length);
      index += 1
    ) {
      const rowId = rowIds[index]!;
      const value = `Capacity fixture ${String(index).padStart(8, '0')}`;
      statements.push(
        {
          args: [
            rowId,
            input.workspaceId,
            input.tableId,
            `capacity:${input.runId}:${String(index).padStart(8, '0')}`,
          ],
          sql: 'insert into rows (id, workspace_id, table_id, position) values (?, ?, ?, ?)',
        },
        {
          args: [
            randomUUID(),
            input.workspaceId,
            input.tableId,
            rowId,
            input.columnId,
            value,
            value,
          ],
          sql: "insert into cells (id, workspace_id, table_id, row_id, column_id, value_type, value_text, search_text) values (?, ?, ?, ?, ?, 'text', ?, ?)",
        }
      );
    }
    await client.batch(statements, 'write');
  }
  return rowIds;
}

async function performGridRead(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<void> {
  const response = await safeFetch(fetchImpl, url, {
    headers,
    ...(signal ? { signal } : {}),
  });
  requireStatus(response, 200, 'A measured grid read failed.');
  const body = await safeJson(
    response,
    'A measured grid response was malformed.'
  );
  if (
    !body ||
    typeof body !== 'object' ||
    !Array.isArray((body as Record<string, unknown>).rows) ||
    (body as { rows: unknown[] }).rows.length !== 100
  ) {
    throw new ProductionCapacityDrillError(
      'A measured grid response did not contain 100 rows.'
    );
  }
}

async function capacityJson(
  fetchImpl: typeof fetch,
  url: string,
  input: {
    body: string;
    expectedStatus: number;
    method: string;
    origin: string;
    phase: string;
  }
): Promise<unknown> {
  const response = await safeFetch(fetchImpl, url, {
    body: input.body,
    headers: {
      'content-type': 'application/json',
      origin: input.origin,
    },
    method: input.method,
  });
  requireStatus(
    response,
    input.expectedStatus,
    `Capacity ${input.phase} failed.`
  );
  return safeJson(
    response,
    `The capacity ${input.phase} response was malformed.`
  );
}

async function safeFetch(
  fetchImpl: typeof fetch,
  url: string,
  init?: RequestInit
): Promise<Response> {
  try {
    const requestTimeout = AbortSignal.timeout(15_000);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, requestTimeout])
      : requestTimeout;
    return await fetchImpl(url, { ...init, signal });
  } catch {
    throw new ProductionCapacityDrillError(
      'A capacity HTTP request could not complete.'
    );
  }
}

async function safeJson(response: Response, message: string): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ProductionCapacityDrillError(message);
  }
}

function requireStatus(response: Response, expected: number, message: string) {
  if (response.status !== expected) {
    throw new ProductionCapacityDrillError(message);
  }
}

async function one(
  client: Client,
  sql: string,
  args: (number | string)[]
): Promise<Record<string, unknown>> {
  const result = await client.execute({ args, sql });
  const row = result.rows[0];
  if (!row) {
    throw new ProductionCapacityDrillError(
      'The capacity database fixture is incomplete.'
    );
  }
  return row as Record<string, unknown>;
}

async function safely<T>(
  name: string,
  operation: () => Promise<T>
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ProductionCapacityDrillError) throw error;
    throw new ProductionCapacityDrillError(`Capacity ${name} failed.`, {
      cause: error,
    });
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new ProductionCapacityDrillError(`${name} is required.`);
  if (/[\0\r\n]/u.test(value)) {
    throw new ProductionCapacityDrillError(
      `${name} contains forbidden control characters.`
    );
  }
  return value;
}

function boundedText(
  environment: NodeJS.ProcessEnv,
  name: string,
  maximum: number
): string {
  const value = required(environment, name);
  if (value.length > maximum) {
    throw new ProductionCapacityDrillError(`${name} is too long.`);
  }
  return value;
}

function integer(
  environment: NodeJS.ProcessEnv,
  name: string,
  minimum: number,
  maximum: number
): number {
  const value = Number(required(environment, name));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ProductionCapacityDrillError(
      `${name} must be an integer from ${minimum} to ${maximum}.`
    );
  }
  return value;
}

function pattern(
  environment: NodeJS.ProcessEnv,
  name: string,
  expression: RegExp,
  description: string
): string {
  const value = required(environment, name);
  if (!expression.test(value)) {
    throw new ProductionCapacityDrillError(`${name} must be ${description}.`);
  }
  return value;
}

function dnsLabel(environment: NodeJS.ProcessEnv, name: string): string {
  const value = boundedText(environment, name, 63);
  if (!DNS_LABEL_PATTERN.test(value)) {
    throw new ProductionCapacityDrillError(
      `${name} must be a lowercase Kubernetes DNS label.`
    );
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function dnsSubdomain(environment: NodeJS.ProcessEnv, name: string): string {
  const value = boundedText(environment, name, 253);
  if (!value.split('.').every((part) => DNS_LABEL_PATTERN.test(part))) {
    throw new ProductionCapacityDrillError(
      `${name} must be a lowercase Kubernetes DNS subdomain.`
    );
  }
  return value;
}

function canonicalHttpsOrigin(value: string): string {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProductionCapacityDrillError(
      'BYOK_GRID_CAPACITY_APP_ORIGIN must be a valid URL.'
    );
  }
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash ||
    localHostname(parsed.hostname)
  ) {
    throw new ProductionCapacityDrillError(
      'BYOK_GRID_CAPACITY_APP_ORIGIN must be a non-loopback credential-free HTTPS origin.'
    );
  }
  return parsed.origin;
}

function canonicalLibsqlUrl(value: string): string {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ProductionCapacityDrillError(
      'BYOK_GRID_CAPACITY_DATABASE_URL must be a valid URL.'
    );
  }
  if (
    parsed.protocol !== 'libsql:' ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    (parsed.pathname && parsed.pathname !== '/') ||
    parsed.search ||
    parsed.hash ||
    localHostname(parsed.hostname)
  ) {
    throw new ProductionCapacityDrillError(
      'BYOK_GRID_CAPACITY_DATABASE_URL must be a non-loopback credential-free libsql:// host.'
    );
  }
  return `libsql://${parsed.host.toLowerCase()}`;
}

function localHostname(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return (
    value === 'localhost' ||
    value.endsWith('.localhost') ||
    value === '0.0.0.0' ||
    value.startsWith('127.') ||
    value === '[::]' ||
    value === '[::1]'
  );
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductionCapacityDrillError(
      `The ${name} response is malformed.`
    );
  }
  return value as Record<string, unknown>;
}

function objectField(
  value: Record<string, unknown>,
  field: string,
  name: string
): Record<string, unknown> {
  return object(value[field], name);
}

function objectOrUndefined(
  value: unknown
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(
  value: Record<string, unknown>,
  field: string,
  name: string
): string {
  const result = value[field];
  if (typeof result !== 'string' || !result) {
    throw new ProductionCapacityDrillError(
      `The ${name} response is malformed.`
    );
  }
  return result;
}

function uuidField(value: unknown, field: string, name: string): string {
  const result = stringField(object(value, name), field, name);
  if (!UUID_PATTERN.test(result)) {
    throw new ProductionCapacityDrillError(
      `The ${name} response is malformed.`
    );
  }
  return result;
}

function integerField(
  value: Record<string, unknown>,
  field: string,
  name: string
): number {
  const result = value[field];
  if (!Number.isInteger(result) || (result as number) < 0) {
    throw new ProductionCapacityDrillError(
      `The ${name} response is malformed.`
    );
  }
  return result as number;
}

function nonnegativeNumberField(
  value: Record<string, unknown>,
  field: string,
  name: string
): number {
  const result = value[field];
  if (typeof result !== 'number' || !Number.isFinite(result) || result < 0) {
    throw new ProductionCapacityDrillError(
      `The ${name} response is malformed.`
    );
  }
  return result;
}

function selectorPart(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > 253 ||
    /[,=!()\s\0\r\n]/u.test(value)
  ) {
    throw new ProductionCapacityDrillError(
      'The worker deployment has an unsupported label selector.'
    );
  }
  return value;
}

function readyCondition(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (condition) => condition?.type === 'Ready' && condition.status === 'True'
    )
  );
}
