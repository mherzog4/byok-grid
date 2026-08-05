import {
  ConnectorError,
  executeAction,
  executeBuiltInAction,
  executeSandboxConnector,
  extractConnectorCellValue,
  getBuiltInConnectorManifest,
  getConnectorManifest,
  getSandboxConnector,
  guardedEgressFetch,
  httpConnector,
  loadSandboxConnectorRegistry,
} from '@byok-grid/connectors';
import {
  cellRuns,
  cells,
  credentials,
  markSqliteCellRunRunning,
  markSqliteCellRunSucceeded,
  requireSqliteConnectorExecutionAllowed,
  setSqliteCellRunFailure,
  SqliteConnectorRevokedError,
  workspaceKeys,
} from '@byok-grid/db';
import {
  httpWaterfallRunPlanSchema,
  MAXIMUM_CELL_RUN_ATTEMPTS,
  type CellRunInput,
  type CellRunResult,
} from '@byok-grid/domain';
import {
  decryptCredential,
  unwrapWorkspaceKeyFromRing,
} from '@byok-grid/security';
import { NonRetryableError } from '@hatchet-dev/typescript-sdk/v1';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { workflowWorkerConfig } from './config';
import { workflowMasterKeys } from './master-keys';
import { workflowDb } from './database';
import { executeWaterfallPlan } from './waterfall';

export const MAXIMUM_SQLITE_CELL_RUN_RETRIES = MAXIMUM_CELL_RUN_ATTEMPTS - 1;

export async function executeSqliteCellRun(
  input: CellRunInput,
  retryCount: number
): Promise<CellRunResult> {
  const state = await markSqliteCellRunRunning(workflowDb, input);
  if (state !== 'ready') return { runId: input.runId, status: state };

  try {
    const execution = await loadExecution(input);
    await requireSqliteConnectorExecutionAllowed(
      workflowDb,
      input.workspaceId,
      {
        artifactSha256: execution.run.artifactSha256,
        connectorId: execution.run.connectorId,
        connectorVersion: execution.run.connectorVersion,
        publisherKeyIds: execution.run.publisherKeyIds,
      }
    );
    let output: unknown;
    let value: Parameters<typeof markSqliteCellRunSucceeded>[1]['value'];
    if (execution.run.connectorId === 'http_waterfall') {
      output = await executeStoredWaterfall(execution, input.workspaceId);
      value = extractConnectorCellValue(output, { valueType: 'json' });
    } else {
      const sandboxConnectors = loadSandboxConnectorRegistry();
      const manifest = getConnectorManifest(
        execution.run.connectorId,
        execution.run.connectorVersion,
        sandboxConnectors
      );
      const action = manifest?.actions.find(
        (candidate) => candidate.id === execution.run.actionId
      );
      if (!manifest || !action) {
        throw new ConnectorError(
          'invalid_input',
          `Unknown connector action ${execution.run.connectorId}.${execution.run.actionId}.`,
          false
        );
      }
      const builtIn = getBuiltInConnectorManifest(execution.run.connectorId);
      const credential = resolveCredential(execution, input.workspaceId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        if (builtIn?.version === execution.run.connectorVersion) {
          output = await executeBuiltInAction({
            actionId: execution.run.actionId,
            connectorId: execution.run.connectorId,
            context: {
              abortSignal: controller.signal,
              allowedHosts: new Set(
                (action.hostPolicy.kind === 'fixed'
                  ? action.hostPolicy.hosts
                  : execution.run.allowedHosts
                ).map((host) => host.toLowerCase())
              ),
              fetch: guardedEgressFetch,
              idempotencyKey: execution.run.id,
              maxResponseBytes: 1_048_576,
            },
            credential,
            input: execution.run.input,
          });
        } else {
          output = await executeCommunityConnector({
            action,
            credential,
            execution,
            input,
            sandboxConnectors,
          });
        }
      } finally {
        clearTimeout(timeout);
      }
      value = extractConnectorCellValue(output, action.cellOutput);
    }
    await markSqliteCellRunSucceeded(workflowDb, {
      ...input,
      connectorId: execution.run.connectorId,
      output,
      value,
    });
    if (execution.credential) {
      await workflowDb
        .update(credentials)
        .set({ lastUsedAt: new Date(), updatedAt: new Date() })
        .where(
          and(
            eq(credentials.id, execution.credential.id),
            eq(credentials.workspaceId, input.workspaceId)
          )
        );
    }
    return { runId: input.runId, status: 'succeeded' };
  } catch (error) {
    const failure = classifyFailure(error);
    const retrying =
      failure.retryable && retryCount < MAXIMUM_SQLITE_CELL_RUN_RETRIES;
    await setSqliteCellRunFailure(workflowDb, {
      ...input,
      errorCode: failure.code,
      errorMessage: failure.message,
      retrying,
    });
    if (!failure.retryable) throw new NonRetryableError(failure.message);
    throw new Error(failure.message, { cause: error });
  }
}

async function executeCommunityConnector(input: {
  action: NonNullable<
    ReturnType<typeof getConnectorManifest>
  >['actions'][number];
  credential: Readonly<Record<string, unknown>> | null;
  execution: Awaited<ReturnType<typeof loadExecution>>;
  input: CellRunInput;
  sandboxConnectors: ReturnType<typeof loadSandboxConnectorRegistry>;
}) {
  const sandbox = getSandboxConnector(
    input.execution.run.connectorId,
    input.execution.run.connectorVersion,
    input.sandboxConnectors
  );
  if (
    !sandbox ||
    input.execution.run.artifactSha256 === null ||
    sandbox.artifact.sha256 !== input.execution.run.artifactSha256
  ) {
    throw new ConnectorError(
      'policy',
      'The installed community connector no longer matches its pinned artifact.',
      false
    );
  }
  if (
    !workflowWorkerConfig.CONNECTOR_RUNNER_URL ||
    !workflowWorkerConfig.CONNECTOR_RUNNER_SHARED_SECRET
  ) {
    throw new ConnectorError(
      'policy',
      'The connector runner is not configured for this deployment.',
      false
    );
  }
  return executeSandboxConnector(
    {
      actionId: input.execution.run.actionId,
      connectorId: input.execution.run.connectorId,
      connectorVersion: input.execution.run.connectorVersion,
      credential: z.record(z.string(), z.json()).parse(input.credential ?? {}),
      credentialSchema: sandbox.manifest.credentialSchema,
      hostPolicy: input.action.hostPolicy,
      input: z.json().parse(input.execution.run.input),
      inputSchema: input.action.inputSchema,
      outputSchema: input.action.outputSchema,
      runId: input.input.runId,
    },
    {
      sharedSecret: workflowWorkerConfig.CONNECTOR_RUNNER_SHARED_SECRET,
      url: workflowWorkerConfig.CONNECTOR_RUNNER_URL,
    },
    { egressFetch: guardedEgressFetch }
  );
}

async function executeStoredWaterfall(
  execution: Awaited<ReturnType<typeof loadExecution>>,
  workspaceId: string
): Promise<unknown> {
  const plan = httpWaterfallRunPlanSchema.parse(execution.run.input);
  return executeWaterfallPlan({
    plan,
    priorOutput: execution.run.output,
    runId: execution.run.id,
    async executeProvider(provider, idempotencyKey) {
      const credential = await resolveWaterfallCredential(
        provider.credentialId,
        execution.workspaceKey,
        workspaceId
      );
      return executeHttpProvider({
        allowedHosts: execution.run.allowedHosts,
        credential,
        idempotencyKey,
        input: { method: 'GET', url: provider.url },
      });
    },
    async saveProgress(progress) {
      await workflowDb
        .update(cellRuns)
        .set({ output: progress, updatedAt: new Date() })
        .where(
          and(
            eq(cellRuns.id, execution.run.id),
            eq(cellRuns.workspaceId, workspaceId)
          )
        );
    },
  });
}

async function executeHttpProvider(input: {
  allowedHosts: readonly string[];
  credential: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  input: unknown;
}): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    return await executeAction({
      action: httpConnector.actions.request,
      context: {
        abortSignal: controller.signal,
        allowedHosts: new Set(
          input.allowedHosts.map((host) => host.toLowerCase())
        ),
        fetch: guardedEgressFetch,
        idempotencyKey: input.idempotencyKey,
        maxResponseBytes: 1_048_576,
      },
      credential: input.credential,
      credentialSchema: httpConnector.credentialSchema,
      input: input.input,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function resolveWaterfallCredential(
  credentialId: string | null,
  workspaceKeyRecord: typeof workspaceKeys.$inferSelect | null,
  workspaceId: string
): Promise<Readonly<Record<string, unknown>>> {
  if (!credentialId) return { type: 'none' };
  const [credential] = await workflowDb
    .select()
    .from(credentials)
    .where(
      and(
        eq(credentials.id, credentialId),
        eq(credentials.workspaceId, workspaceId),
        eq(credentials.connectorId, 'http'),
        isNull(credentials.revokedAt)
      )
    )
    .limit(1);
  if (!credential) {
    throw new ConnectorError(
      'authentication',
      'The selected waterfall credential is missing or revoked.',
      false
    );
  }
  if (!workspaceKeyRecord) {
    throw new ConnectorError(
      'authentication',
      'The workspace encryption key is missing.',
      false
    );
  }
  const workspaceKey = unwrapWorkspaceKeyFromRing(
    workspaceId,
    workspaceKeyRecord.wrappedKey,
    workflowMasterKeys
  );
  try {
    const value = decryptCredential(
      workspaceId,
      credential.id,
      workspaceKey,
      credential.encryptedValue
    );
    await workflowDb
      .update(credentials)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(credentials.id, credential.id),
          eq(credentials.workspaceId, workspaceId)
        )
      );
    return value;
  } finally {
    workspaceKey.fill(0);
  }
}

async function loadExecution(input: CellRunInput) {
  const [execution] = await workflowDb
    .select({
      credential: credentials,
      run: cellRuns,
      workspaceKey: workspaceKeys,
    })
    .from(cellRuns)
    .innerJoin(
      cells,
      and(
        eq(cells.id, cellRuns.cellId),
        eq(cells.workspaceId, cellRuns.workspaceId)
      )
    )
    .leftJoin(
      credentials,
      and(
        eq(credentials.id, cellRuns.credentialId),
        eq(credentials.workspaceId, cellRuns.workspaceId)
      )
    )
    .leftJoin(
      workspaceKeys,
      eq(workspaceKeys.workspaceId, cellRuns.workspaceId)
    )
    .where(
      and(
        eq(cellRuns.id, input.runId),
        eq(cellRuns.workspaceId, input.workspaceId),
        eq(cellRuns.cellId, input.cellId),
        eq(cellRuns.inputFingerprint, input.inputFingerprint),
        eq(cells.rowId, input.rowId),
        eq(cells.columnId, input.columnId)
      )
    )
    .limit(1);
  if (!execution) {
    throw new ConnectorError(
      'invalid_input',
      'The cell run does not exist or its input changed.',
      false
    );
  }
  if (
    execution.credential &&
    (execution.credential.revokedAt ||
      execution.credential.connectorId !== execution.run.connectorId)
  ) {
    throw new ConnectorError(
      'authentication',
      'The selected connector credential is missing or revoked.',
      false
    );
  }
  return execution;
}

function resolveCredential(
  execution: Awaited<ReturnType<typeof loadExecution>>,
  workspaceId: string
): Readonly<Record<string, unknown>> | null {
  if (!execution.credential) {
    return execution.run.connectorId === 'http' ? { type: 'none' } : null;
  }
  if (!execution.workspaceKey) {
    throw new ConnectorError(
      'authentication',
      'The workspace encryption key is missing.',
      false
    );
  }
  const workspaceKey = unwrapWorkspaceKeyFromRing(
    workspaceId,
    execution.workspaceKey.wrappedKey,
    workflowMasterKeys
  );
  try {
    return decryptCredential(
      workspaceId,
      execution.credential.id,
      workspaceKey,
      execution.credential.encryptedValue
    );
  } finally {
    workspaceKey.fill(0);
  }
}

function classifyFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof SqliteConnectorRevokedError) {
    return {
      code: 'connector_revoked',
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof ConnectorError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof z.ZodError) {
    return {
      code: 'invalid_input',
      message: 'The connector input or credential is invalid.',
      retryable: false,
    };
  }
  return {
    code: 'internal',
    message: 'The connector run failed unexpectedly.',
    retryable: true,
  };
}
