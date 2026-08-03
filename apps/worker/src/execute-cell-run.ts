import {
  ConnectorError,
  executeAction,
  executeBuiltInAction,
  extractConnectorCellValue,
  getBuiltInConnectorManifest,
  getConnectorManifest,
  httpConnector,
  type ConnectorCellValue,
} from '@byok-grid/connectors';
import {
  cellRuns,
  cells,
  credentials,
  outboxEvents,
  recomputeDependentFormulasForRow,
  recordRowMutationAndMaybeQueueSettlement,
  rows,
  serializeCellValue,
  usageLedger,
  workspaceKeys,
  requireConnectorExecutionAllowed,
} from '@byok-grid/db/postgres';
import {
  cellRunInputSchema,
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
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { workerMasterKeys } from './master-keys';
import { classifyCellRunFailure } from './cell-run-failure-policy';
import { config } from './config';
import { db } from './database';
import { guardedEgressFetch } from '@byok-grid/connectors';
import { hatchet } from './hatchet';
import { executeWaterfallPlan } from './waterfall';
import { providerUnitsForRun } from './usage';
import { executeSandboxConnector } from './sandbox-runner';
import { requirePinnedSandboxConnector } from './sandbox-execution-policy';

const maximumRetries = MAXIMUM_CELL_RUN_ATTEMPTS - 1;

export const executeCellRunTask = hatchet.task({
  name: 'execute-cell-run',
  retries: maximumRetries,
  backoff: { factor: 2, maxSeconds: 60 },
  idempotency: {
    expression: 'input.runId',
    fallbackTtlMs: 86_400_000,
    strategy: 'status',
  },
  inputValidator: cellRunInputSchema,
  fn: (input, context) =>
    executeCellRun(cellRunInputSchema.parse(input), context.retryCount()),
});

async function executeCellRun(
  input: CellRunInput,
  retryCount: number
): Promise<CellRunResult> {
  const parsedInput = cellRunInputSchema.parse(input);
  const execution = await loadExecution(parsedInput);

  if (execution.run.status === 'succeeded') {
    return { runId: execution.run.id, status: 'succeeded' };
  }
  if (execution.run.status === 'cancelled') {
    return { runId: execution.run.id, status: 'cancelled' };
  }

  if (
    !(await markRunning(
      execution.run.id,
      execution.run.cellId,
      input.workspaceId
    ))
  ) {
    return terminalResultAfterLostTransition(parsedInput);
  }

  try {
    const result =
      execution.run.connectorId === 'http_waterfall'
        ? await executeStoredWaterfall(execution, input.workspaceId).then(
            (output) => ({
              cellValue: extractConnectorCellValue(output, {
                valueType: 'json',
              }),
              output,
            })
          )
        : await executeStoredConnector(execution, input.workspaceId);

    const stored = await markSucceeded(
      execution.run.id,
      execution.run.cellId,
      input.workspaceId,
      result.output,
      result.cellValue,
      execution.run.connectorId
    );
    if (!stored) return terminalResultAfterLostTransition(parsedInput);
    return { runId: execution.run.id, status: 'succeeded' };
  } catch (error) {
    const failure = classifyCellRunFailure(error);
    if (failure.retryable && retryCount < maximumRetries) {
      const scheduled = await markRetryScheduled(
        execution.run.id,
        execution.run.cellId,
        input.workspaceId,
        failure.code,
        failure.message
      );
      if (!scheduled) return terminalResultAfterLostTransition(parsedInput);
      throw new Error(failure.message, { cause: error });
    }
    const stored = await markFailed(
      execution.run.id,
      execution.run.cellId,
      input.workspaceId,
      failure.code,
      failure.message
    );
    if (!stored) return terminalResultAfterLostTransition(parsedInput);
    if (!failure.retryable) {
      throw new NonRetryableError(failure.message);
    }
    throw new Error(failure.message, { cause: error });
  }
}

async function markRetryScheduled(
  runId: string,
  cellId: string,
  workspaceId: string,
  errorCode: string,
  errorMessage: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [scheduled] = await tx
      .update(cellRuns)
      .set({
        errorCode,
        errorMessage,
        finishedAt: null,
        status: 'queued',
        updatedAt: now,
      })
      .where(
        and(
          eq(cellRuns.id, runId),
          eq(cellRuns.workspaceId, workspaceId),
          eq(cellRuns.status, 'running')
        )
      )
      .returning({ id: cellRuns.id });
    if (!scheduled) return false;
    await tx
      .update(cells)
      .set({ status: 'queued', updatedAt: now })
      .where(and(eq(cells.id, cellId), eq(cells.workspaceId, workspaceId)));
    return true;
  });
}

async function terminalResultAfterLostTransition(
  input: CellRunInput
): Promise<CellRunResult> {
  const latest = await loadExecution(input);
  if (
    latest.run.status === 'cancelled' ||
    latest.run.status === 'failed' ||
    latest.run.status === 'succeeded'
  ) {
    return { runId: latest.run.id, status: latest.run.status };
  }
  throw new Error('The cell run is already being executed.');
}

async function executeStoredConnector(
  execution: Awaited<ReturnType<typeof loadExecution>>,
  workspaceId: string
): Promise<{ cellValue: ConnectorCellValue; output: unknown }> {
  await requireConnectorExecutionAllowed(db, workspaceId, {
    artifactSha256: execution.run.artifactSha256,
    connectorId: execution.run.connectorId,
    connectorVersion: execution.run.connectorVersion,
    publisherKeyIds: execution.run.publisherKeyIds,
  });
  const credential = execution.credential
    ? resolveCredential(execution, workspaceId)
    : execution.run.connectorId === 'http'
      ? { type: 'none' }
      : null;
  if (execution.credential) {
    await db
      .update(credentials)
      .set({ lastUsedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(credentials.id, execution.credential.id),
          eq(credentials.workspaceId, workspaceId)
        )
      );
  }
  const manifest = getConnectorManifest(
    execution.run.connectorId,
    execution.run.connectorVersion
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
  const allowedHosts =
    action.hostPolicy.kind === 'fixed'
      ? action.hostPolicy.hosts
      : execution.run.allowedHosts;
  const output = await executeRegisteredAction({
    actionId: execution.run.actionId,
    allowedHosts,
    artifactSha256: execution.run.artifactSha256,
    connectorId: execution.run.connectorId,
    connectorVersion: execution.run.connectorVersion,
    credential,
    hostPolicy: action.hostPolicy,
    idempotencyKey: execution.run.id,
    input: execution.run.input,
  });
  return {
    cellValue: extractConnectorCellValue(output, action.cellOutput),
    output,
  };
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
      return executeHttpAction({
        action: httpConnector.actions.request,
        allowedHosts: execution.run.allowedHosts,
        credential,
        idempotencyKey,
        input: { method: 'GET', url: provider.url },
      });
    },
    async saveProgress(progress) {
      await db
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

async function executeHttpAction(input: {
  action: typeof httpConnector.actions.request;
  allowedHosts: readonly string[];
  credential: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
  input: unknown;
}): Promise<unknown> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);
  try {
    return await executeAction({
      action: input.action,
      context: {
        abortSignal: abortController.signal,
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

async function executeRegisteredAction(input: {
  actionId: string;
  allowedHosts: readonly string[];
  artifactSha256: string | null;
  connectorId: string;
  connectorVersion: string;
  credential: unknown;
  hostPolicy: NonNullable<
    ReturnType<typeof getConnectorManifest>
  >['actions'][number]['hostPolicy'];
  idempotencyKey: string;
  input: unknown;
}): Promise<unknown> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);
  try {
    const builtIn = getBuiltInConnectorManifest(input.connectorId);
    if (!builtIn || builtIn.version !== input.connectorVersion) {
      const sandbox = requirePinnedSandboxConnector(input);
      if (
        !config.CONNECTOR_RUNNER_URL ||
        !config.CONNECTOR_RUNNER_SHARED_SECRET
      ) {
        throw new ConnectorError(
          'policy',
          'The connector runner is not configured for this deployment.',
          false
        );
      }
      const action = sandbox.manifest.actions.find(
        (candidate) => candidate.id === input.actionId
      );
      if (!action) {
        throw new ConnectorError(
          'invalid_input',
          'The sandbox connector action is not installed.',
          false
        );
      }
      const credential = z
        .record(z.string(), z.json())
        .parse(input.credential ?? {});
      const actionInput = z.json().parse(input.input);
      return executeSandboxConnector(
        {
          actionId: input.actionId,
          connectorId: input.connectorId,
          connectorVersion: input.connectorVersion,
          credential,
          credentialSchema: sandbox.manifest.credentialSchema,
          hostPolicy: input.hostPolicy,
          input: actionInput,
          inputSchema: action.inputSchema,
          outputSchema: action.outputSchema,
          runId: input.idempotencyKey,
        },
        {
          sharedSecret: config.CONNECTOR_RUNNER_SHARED_SECRET,
          url: config.CONNECTOR_RUNNER_URL,
        },
        { egressFetch: guardedEgressFetch }
      );
    }
    return await executeBuiltInAction({
      actionId: input.actionId,
      connectorId: input.connectorId,
      context: {
        abortSignal: abortController.signal,
        allowedHosts: new Set(
          input.allowedHosts.map((host) => host.toLowerCase())
        ),
        fetch: guardedEgressFetch,
        idempotencyKey: input.idempotencyKey,
        maxResponseBytes: 1_048_576,
      },
      credential: input.credential,
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
  const [credential] = await db
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
    workerMasterKeys
  );
  try {
    const value = decryptCredential(
      workspaceId,
      credential.id,
      workspaceKey,
      credential.encryptedValue
    );
    await db
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
  const [result] = await db
    .select({
      credential: credentials,
      run: cellRuns,
      workspaceKey: workspaceKeys,
    })
    .from(cellRuns)
    .leftJoin(
      workspaceKeys,
      eq(workspaceKeys.workspaceId, cellRuns.workspaceId)
    )
    .innerJoin(
      cells,
      and(
        eq(cells.id, cellRuns.cellId),
        eq(cells.workspaceId, cellRuns.workspaceId)
      )
    )
    .leftJoin(credentials, eq(credentials.id, cellRuns.credentialId))
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

  if (!result) {
    throw new NonRetryableError(
      'The cell run does not exist or its input changed.'
    );
  }
  if (result.credential?.revokedAt) {
    throw new NonRetryableError('The selected credential has been revoked.');
  }
  if (
    result.credential &&
    result.credential.workspaceId !== input.workspaceId
  ) {
    throw new NonRetryableError('The credential belongs to another workspace.');
  }
  if (
    result.credential &&
    result.credential.connectorId !== result.run.connectorId
  ) {
    throw new NonRetryableError(
      'The credential does not belong to the run connector.'
    );
  }

  return result;
}

function resolveCredential(
  execution: Awaited<ReturnType<typeof loadExecution>>,
  workspaceId: string
): Readonly<Record<string, unknown>> {
  if (!execution.credential) {
    return { type: 'none' };
  }
  if (!execution.workspaceKey) {
    throw new NonRetryableError('The workspace encryption key is missing.');
  }

  const workspaceKey = unwrapWorkspaceKeyFromRing(
    workspaceId,
    execution.workspaceKey.wrappedKey,
    workerMasterKeys
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

async function markRunning(
  runId: string,
  cellId: string,
  workspaceId: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(cellRuns)
      .set({
        attempt: sql`${cellRuns.attempt} + 1`,
        errorCode: null,
        errorMessage: null,
        startedAt: new Date(),
        status: 'running',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(cellRuns.id, runId),
          eq(cellRuns.workspaceId, workspaceId),
          eq(cellRuns.status, 'queued')
        )
      )
      .returning({ id: cellRuns.id });
    if (!claimed) return false;
    await tx
      .update(cells)
      .set({ status: 'running', updatedAt: new Date() })
      .where(and(eq(cells.id, cellId), eq(cells.workspaceId, workspaceId)));
    return true;
  });
}

async function markSucceeded(
  runId: string,
  cellId: string,
  workspaceId: string,
  output: unknown,
  cellValue: ConnectorCellValue,
  connectorId: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const storedValue = serializeCellValue(cellValue);
    const [targetCell] = await tx
      .select({
        columnId: cells.columnId,
        rowId: cells.rowId,
        tableId: cells.tableId,
      })
      .from(cells)
      .where(and(eq(cells.id, cellId), eq(cells.workspaceId, workspaceId)))
      .limit(1);
    if (!targetCell) throw new Error('The completed cell does not exist.');
    const [lockedRow] = await tx
      .select({ id: rows.id })
      .from(rows)
      .where(
        and(
          eq(rows.id, targetCell.rowId),
          eq(rows.tableId, targetCell.tableId),
          eq(rows.workspaceId, workspaceId)
        )
      )
      .limit(1)
      .for('update');
    if (!lockedRow) throw new Error('The completed row does not exist.');
    const [completed] = await tx
      .update(cellRuns)
      .set({ finishedAt: now, output, status: 'succeeded', updatedAt: now })
      .where(
        and(
          eq(cellRuns.id, runId),
          eq(cellRuns.workspaceId, workspaceId),
          eq(cellRuns.status, 'running')
        )
      )
      .returning({ id: cellRuns.id });
    if (!completed) return false;
    await tx
      .update(cells)
      .set({
        ...storedValue,
        status: 'succeeded',
        updatedAt: now,
        version: sql`${cells.version} + 1`,
      })
      .where(and(eq(cells.id, cellId), eq(cells.workspaceId, workspaceId)));
    const changedFormulaIds = await recomputeDependentFormulasForRow(tx, {
      changedColumnIds: [targetCell.columnId],
      rowId: targetCell.rowId,
      tableId: targetCell.tableId,
      workspaceId,
    });
    await recordRowMutationAndMaybeQueueSettlement(tx, {
      changedColumnIds: [targetCell.columnId, ...changedFormulaIds],
      rowId: targetCell.rowId,
      tableId: targetCell.tableId,
      workspaceId,
    });
    await tx.insert(outboxEvents).values({
      aggregateId: cellId,
      aggregateType: 'cell',
      eventType: 'cell.run_succeeded',
      payload: { cellId, runId },
      workspaceId,
    });
    const providerUnits = providerUnitsForRun(connectorId, output);
    if (providerUnits) {
      await tx
        .insert(usageLedger)
        .values({ connectorId, providerUnits, runId, workspaceId })
        .onConflictDoNothing({ target: usageLedger.runId });
    }
    return true;
  });
}

async function markFailed(
  runId: string,
  cellId: string,
  workspaceId: string,
  errorCode: string,
  errorMessage: string
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const [targetCell] = await tx
      .select({ rowId: cells.rowId, tableId: cells.tableId })
      .from(cells)
      .where(and(eq(cells.id, cellId), eq(cells.workspaceId, workspaceId)))
      .limit(1);
    if (!targetCell) throw new Error('The failed cell does not exist.');
    const [lockedRow] = await tx
      .select({ id: rows.id })
      .from(rows)
      .where(
        and(
          eq(rows.id, targetCell.rowId),
          eq(rows.tableId, targetCell.tableId),
          eq(rows.workspaceId, workspaceId)
        )
      )
      .limit(1)
      .for('update');
    if (!lockedRow) throw new Error('The failed row does not exist.');
    const [failed] = await tx
      .update(cellRuns)
      .set({
        errorCode,
        errorMessage,
        finishedAt: now,
        status: 'failed',
        updatedAt: now,
      })
      .where(
        and(
          eq(cellRuns.id, runId),
          eq(cellRuns.workspaceId, workspaceId),
          eq(cellRuns.status, 'running')
        )
      )
      .returning({ id: cellRuns.id });
    if (!failed) return false;
    await tx
      .update(cells)
      .set({ status: 'failed', updatedAt: now })
      .where(and(eq(cells.id, cellId), eq(cells.workspaceId, workspaceId)));
    await recordRowMutationAndMaybeQueueSettlement(tx, {
      changedColumnIds: [],
      rowId: targetCell.rowId,
      tableId: targetCell.tableId,
      workspaceId,
    });
    await tx.insert(outboxEvents).values({
      aggregateId: cellId,
      aggregateType: 'cell',
      eventType: 'cell.run_failed',
      payload: { cellId, errorCode, runId },
      workspaceId,
    });
    return true;
  });
}
