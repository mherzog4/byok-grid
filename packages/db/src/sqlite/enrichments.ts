import {
  connectorActionColumnConfigurationSchema,
  hasWorkspacePermission,
  httpEnrichmentColumnConfigurationSchema,
  httpWaterfallColumnConfigurationSchema,
  MAXIMUM_TABLE_COLUMNS,
  shouldSelectCellForBulkRun,
  workflowRowBatchSchema,
  type BulkRunMode,
  type CellRunInput,
  type ConnectorActionInputBinding,
  type ConnectorRunMode,
  type WorkflowRowBatch,
} from '@byok-grid/domain';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import {
  type SqliteDatabase,
  type SqliteTransaction,
  withSqliteWriteTransaction,
} from './client';
import { serializeSqliteCellValue } from './cell-values';
import { requireSqliteConnectorExecutionAllowed } from './connector-revocations';
import { recomputeDependentSqliteFormulasForRow } from './formulas';
import { recordSqliteRowMutationAndMaybeQueueSettlement } from './row-mutations';
import {
  cellRuns,
  cells,
  columnDependencies,
  columns,
  credentials,
  dataTables,
  outboxEvents,
  rows,
  usageLedger,
  workspaceMembers,
} from './schema';
import type { CellValue } from '@byok-grid/domain';

export class SqliteEnrichmentAccessError extends Error {}
export class SqliteEnrichmentConflictError extends Error {}
export class SqliteEnrichmentValidationError extends Error {}

interface EnrichmentScope {
  tableId: string;
  userId: string;
  workspaceId: string;
}

interface EnrichmentTargetScope {
  columnId: string;
  rowId: string;
  tableId: string;
  workspaceId: string;
}

export async function createSqliteConnectorActionColumn(
  db: SqliteDatabase,
  input: EnrichmentScope & {
    actionId: string;
    artifactSha256?: string | null;
    connectorId: string;
    connectorVersion?: string;
    credentialId: string | null;
    inputBindings: Readonly<Record<string, ConnectorActionInputBinding>>;
    name: string;
    outputValueType: 'boolean' | 'json' | 'number' | 'text';
    protocolVersion: '1.0' | '1.1';
    publisherKeyIds?: readonly string[];
    registrySha256?: string | null;
    runMode?: ConnectorRunMode;
  }
) {
  const configuration = connectorActionColumnConfigurationSchema.parse({
    actionId: input.actionId,
    artifactSha256: input.artifactSha256,
    connectorId: input.connectorId,
    connectorVersion: input.connectorVersion ?? '1.0.0',
    credentialId: input.credentialId,
    inputBindings: input.inputBindings,
    kind: 'connector_action',
    outputValueType: input.outputValueType,
    protocolVersion: input.protocolVersion,
    publisherKeyIds: input.publisherKeyIds,
    registrySha256: input.registrySha256,
    runMode: input.runMode,
  });
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new SqliteEnrichmentValidationError(
      'Column names must contain 1 to 120 characters.'
    );
  }
  const sourceColumnIds = [
    ...new Set(
      Object.values(configuration.inputBindings).flatMap((binding) =>
        binding.kind === 'column' ? [binding.columnId] : []
      )
    ),
  ];

  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTablePermission(tx, input, 'schema.manage');
    await requireSqliteConnectorExecutionAllowed(tx, input.workspaceId, {
      artifactSha256: configuration.artifactSha256,
      connectorId: configuration.connectorId,
      connectorVersion: configuration.connectorVersion,
      publisherKeyIds: configuration.publisherKeyIds,
    });

    const [columnCount] = await tx
      .select({ value: sql<number>`count(*)` })
      .from(columns)
      .where(
        and(
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId)
        )
      );
    if ((columnCount?.value ?? 0) >= MAXIMUM_TABLE_COLUMNS) {
      throw new SqliteEnrichmentValidationError(
        `A table can contain at most ${MAXIMUM_TABLE_COLUMNS} columns.`
      );
    }
    const [duplicate] = await tx
      .select({ id: columns.id })
      .from(columns)
      .where(
        and(
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId),
          sql`lower(${columns.name}) = lower(${name})`
        )
      )
      .limit(1);
    if (duplicate) {
      throw new SqliteEnrichmentConflictError(
        'A column with this name already exists.'
      );
    }
    const sourceColumns =
      sourceColumnIds.length === 0
        ? []
        : await tx
            .select({ id: columns.id })
            .from(columns)
            .where(
              and(
                inArray(columns.id, sourceColumnIds),
                eq(columns.tableId, input.tableId),
                eq(columns.workspaceId, input.workspaceId),
                isNull(columns.archivedAt)
              )
            );
    if (sourceColumns.length !== sourceColumnIds.length) {
      throw new SqliteEnrichmentAccessError(
        'One or more connector input columns are not accessible.'
      );
    }
    if (configuration.credentialId) {
      const [credential] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            eq(credentials.id, configuration.credentialId),
            eq(credentials.workspaceId, input.workspaceId),
            eq(credentials.connectorId, configuration.connectorId),
            isNull(credentials.revokedAt)
          )
        )
        .limit(1);
      if (!credential) {
        throw new SqliteEnrichmentAccessError(
          'The connector credential is not accessible.'
        );
      }
    }

    const position = `z-${Date.now()}-${crypto.randomUUID()}`;
    const [created] = await tx
      .insert(columns)
      .values({
        configuration,
        kind: 'connector',
        name,
        position,
        tableId: input.tableId,
        valueType: configuration.outputValueType,
        workspaceId: input.workspaceId,
      })
      .returning({
        id: columns.id,
        kind: columns.kind,
        name: columns.name,
        position: columns.position,
        valueType: columns.valueType,
      });
    if (!created) throw new Error('The connector column could not be created.');
    if (sourceColumnIds.length > 0) {
      await tx.insert(columnDependencies).values(
        sourceColumnIds.map((sourceColumnId) => ({
          columnId: created.id,
          dependsOnColumnId: sourceColumnId,
          tableId: input.tableId,
          workspaceId: input.workspaceId,
        }))
      );
    }
    return created;
  });
}

export async function createSqliteHttpEnrichmentColumn(
  db: SqliteDatabase,
  input: EnrichmentScope & {
    baseUrl: string;
    credentialId: string | null;
    inputColumnId: string;
    name: string;
    queryParameter: string;
    runMode?: ConnectorRunMode;
  }
) {
  const configuration = httpEnrichmentColumnConfigurationSchema.parse({
    actionId: 'request',
    baseUrl: input.baseUrl,
    connectorId: 'http',
    credentialId: input.credentialId,
    inputColumnId: input.inputColumnId,
    queryParameter: input.queryParameter,
    runMode: input.runMode,
  });
  assertCredentialFreeHttpsUrl(configuration.baseUrl, 'Enrichment endpoints');
  return createSqliteHttpColumn(db, {
    configuration,
    credentialIds: configuration.credentialId
      ? [configuration.credentialId]
      : [],
    errorLabel: 'enrichment',
    inputColumnId: configuration.inputColumnId,
    name: input.name,
    tableId: input.tableId,
    userId: input.userId,
    valueType: 'json',
    workspaceId: input.workspaceId,
  });
}

export async function createSqliteHttpWaterfallColumn(
  db: SqliteDatabase,
  input: EnrichmentScope & {
    inputColumnId: string;
    name: string;
    providers: Array<{
      baseUrl: string;
      credentialId: string | null;
      name: string;
      queryParameter: string;
      resultPath: string;
    }>;
    runMode?: ConnectorRunMode;
  }
) {
  const configuration = httpWaterfallColumnConfigurationSchema.parse({
    inputColumnId: input.inputColumnId,
    kind: 'http_waterfall',
    providers: input.providers.map((provider) => ({
      ...provider,
      id: crypto.randomUUID(),
    })),
    runMode: input.runMode,
    version: 1,
  });
  for (const provider of configuration.providers) {
    assertCredentialFreeHttpsUrl(provider.baseUrl, 'Waterfall endpoints');
  }
  return createSqliteHttpColumn(db, {
    configuration,
    credentialIds: [
      ...new Set(
        configuration.providers.flatMap((provider) =>
          provider.credentialId ? [provider.credentialId] : []
        )
      ),
    ],
    errorLabel: 'waterfall',
    inputColumnId: configuration.inputColumnId,
    name: input.name,
    tableId: input.tableId,
    userId: input.userId,
    valueType: 'json',
    workspaceId: input.workspaceId,
  });
}

async function createSqliteHttpColumn(
  db: SqliteDatabase,
  input: EnrichmentScope & {
    configuration: Readonly<Record<string, unknown>>;
    credentialIds: readonly string[];
    errorLabel: 'enrichment' | 'waterfall';
    inputColumnId: string;
    name: string;
    valueType: 'json';
  }
) {
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new SqliteEnrichmentValidationError(
      'Column names must contain 1 to 120 characters.'
    );
  }
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTablePermission(tx, input, 'schema.manage');
    const [columnCount] = await tx
      .select({ value: sql<number>`count(*)` })
      .from(columns)
      .where(
        and(
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId)
        )
      );
    if ((columnCount?.value ?? 0) >= MAXIMUM_TABLE_COLUMNS) {
      throw new SqliteEnrichmentValidationError(
        `A table can contain at most ${MAXIMUM_TABLE_COLUMNS} columns.`
      );
    }
    const [duplicate] = await tx
      .select({ id: columns.id })
      .from(columns)
      .where(
        and(
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.tableId, input.tableId),
          sql`lower(${columns.name}) = lower(${name})`
        )
      )
      .limit(1);
    if (duplicate) {
      throw new SqliteEnrichmentConflictError(
        'A column with this name already exists.'
      );
    }
    const [sourceColumn] = await tx
      .select({ id: columns.id })
      .from(columns)
      .where(
        and(
          eq(columns.id, input.inputColumnId),
          inArray(columns.kind, ['input', 'formula', 'connector']),
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt)
        )
      )
      .limit(1);
    if (!sourceColumn) {
      throw new SqliteEnrichmentAccessError(
        'The source column is not accessible.'
      );
    }
    if (input.credentialIds.length > 0) {
      const availableCredentials = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(
          and(
            inArray(credentials.id, [...input.credentialIds]),
            eq(credentials.workspaceId, input.workspaceId),
            eq(credentials.connectorId, 'http'),
            isNull(credentials.revokedAt)
          )
        );
      if (availableCredentials.length !== input.credentialIds.length) {
        throw new SqliteEnrichmentAccessError(
          `One or more ${input.errorLabel} credentials are not accessible.`
        );
      }
    }
    const [created] = await tx
      .insert(columns)
      .values({
        configuration: input.configuration,
        kind: 'connector',
        name,
        position: `z-${Date.now()}-${crypto.randomUUID()}`,
        tableId: input.tableId,
        valueType: input.valueType,
        workspaceId: input.workspaceId,
      })
      .returning({
        id: columns.id,
        kind: columns.kind,
        name: columns.name,
        position: columns.position,
        valueType: columns.valueType,
      });
    if (!created) throw new Error('The HTTP column could not be created.');
    await tx.insert(columnDependencies).values({
      columnId: created.id,
      dependsOnColumnId: sourceColumn.id,
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    });
    return created;
  });
}

export async function queueSqliteEnrichmentCellRun(
  db: SqliteDatabase,
  input: EnrichmentScope & { columnId: string; rowId: string }
): Promise<CellRunInput & { status: 'queued' }> {
  return withSqliteWriteTransaction(db, async (tx) => {
    await requireTablePermission(tx, input, 'data.write');
    const queued = await queueConnectorActionRun(tx, {
      ...input,
      dispatch: true,
      mode: 'all',
      runId: crypto.randomUUID(),
    });
    return { ...queued, status: 'queued' };
  });
}

export async function queueSqliteEnrichmentCellRunInTransaction(
  tx: SqliteTransaction,
  input: EnrichmentScope & {
    columnId: string;
    mode: BulkRunMode;
    rowId: string;
    runId?: string;
  }
): Promise<CellRunInput> {
  await requireTablePermission(tx, input, 'data.write');
  return queueConnectorActionRun(tx, {
    ...input,
    dispatch: true,
    runId: input.runId ?? crypto.randomUUID(),
  });
}

export async function queueAutomaticSqliteEnrichmentCellRunInTransaction(
  tx: SqliteTransaction,
  input: EnrichmentTargetScope
): Promise<CellRunInput> {
  return queueConnectorActionRun(tx, {
    ...input,
    dispatch: true,
    mode: 'pending',
    runId: crypto.randomUUID(),
  });
}

export async function queueSqliteWorkflowEnrichmentCellRuns(
  db: SqliteDatabase,
  input: {
    batch: WorkflowRowBatch;
    columnId: string;
    mode: BulkRunMode;
    runId: string;
    stepId: string;
    workspaceId: string;
  }
): Promise<CellRunInput[]> {
  const batch = workflowRowBatchSchema.parse(input.batch);
  return withSqliteWriteTransaction(db, async (tx) => {
    const [column] = await tx
      .select({ tableId: columns.tableId })
      .from(columns)
      .where(
        and(
          eq(columns.id, input.columnId),
          eq(columns.workspaceId, input.workspaceId),
          eq(columns.kind, 'connector'),
          isNull(columns.archivedAt)
        )
      )
      .limit(1);
    if (!column) {
      throw new SqliteEnrichmentAccessError(
        'The workflow enrichment column is unavailable.'
      );
    }
    if (batch.rows.some((row) => row.tableId !== column.tableId)) {
      throw new SqliteEnrichmentValidationError(
        'An enrichment step can only process rows from its column table.'
      );
    }

    const queued: CellRunInput[] = [];
    for (const row of batch.rows) {
      const runId = deterministicCellRunId({
        columnId: input.columnId,
        rowId: row.rowId,
        runId: input.runId,
        stepId: input.stepId,
      });
      const existing = await loadExistingRun(tx, {
        columnId: input.columnId,
        rowId: row.rowId,
        runId,
        workspaceId: input.workspaceId,
      });
      if (existing) {
        queued.push(existing);
        continue;
      }
      const [targetCell] = await tx
        .select({ status: cells.status })
        .from(cells)
        .where(
          and(
            eq(cells.rowId, row.rowId),
            eq(cells.columnId, input.columnId),
            eq(cells.tableId, column.tableId),
            eq(cells.workspaceId, input.workspaceId)
          )
        )
        .limit(1);
      if (!shouldSelectCellForBulkRun(targetCell?.status ?? null, input.mode)) {
        continue;
      }
      queued.push(
        await queueConnectorActionRun(tx, {
          columnId: input.columnId,
          dispatch: false,
          mode: input.mode,
          rowId: row.rowId,
          runId,
          tableId: column.tableId,
          workspaceId: input.workspaceId,
        })
      );
    }
    return queued;
  });
}

export async function markSqliteCellRunRunning(
  db: SqliteDatabase,
  input: CellRunInput
): Promise<'ready' | 'succeeded' | 'cancelled'> {
  return withSqliteWriteTransaction(db, async (tx) => {
    const [run] = await tx
      .select()
      .from(cellRuns)
      .where(runScope(input))
      .limit(1);
    if (!run)
      throw new SqliteEnrichmentAccessError('The cell run does not exist.');
    if (run.status === 'succeeded') return 'succeeded';
    if (run.status === 'cancelled') return 'cancelled';
    if (run.status !== 'queued') {
      throw new SqliteEnrichmentConflictError(
        `The cell run cannot start from status ${run.status}.`
      );
    }
    const now = new Date();
    await tx
      .update(cellRuns)
      .set({
        attempt: run.attempt + 1,
        errorCode: null,
        errorMessage: null,
        startedAt: run.startedAt ?? now,
        status: 'running',
        updatedAt: now,
      })
      .where(eq(cellRuns.id, run.id));
    await tx
      .update(cells)
      .set({ status: 'running', updatedAt: now })
      .where(
        and(
          eq(cells.id, input.cellId),
          eq(cells.workspaceId, input.workspaceId)
        )
      );
    return 'ready';
  });
}

export async function markSqliteCellRunSucceeded(
  db: SqliteDatabase,
  input: CellRunInput & {
    connectorId: string;
    output: unknown;
    value: CellValue;
  }
): Promise<void> {
  await withSqliteWriteTransaction(db, async (tx) => {
    const now = new Date();
    const [target] = await tx
      .select({ rowId: cells.rowId, tableId: cells.tableId })
      .from(cells)
      .where(
        and(
          eq(cells.id, input.cellId),
          eq(cells.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    if (!target)
      throw new SqliteEnrichmentAccessError('The target cell is missing.');
    const [completed] = await tx
      .update(cellRuns)
      .set({
        errorCode: null,
        errorMessage: null,
        finishedAt: now,
        output: input.output,
        status: 'succeeded',
        updatedAt: now,
      })
      .where(and(runScope(input), eq(cellRuns.status, 'running')))
      .returning({ id: cellRuns.id });
    if (!completed) {
      throw new SqliteEnrichmentConflictError('The cell run is not running.');
    }
    await tx
      .update(cells)
      .set({
        ...serializeSqliteCellValue(input.value),
        status: 'succeeded',
        updatedAt: now,
        version: sql`${cells.version} + 1`,
      })
      .where(eq(cells.id, input.cellId));
    const changedFormulaIds = await recomputeDependentSqliteFormulasForRow(tx, {
      changedColumnIds: [input.columnId],
      rowId: target.rowId,
      tableId: target.tableId,
      workspaceId: input.workspaceId,
    });
    await recordSqliteRowMutationAndMaybeQueueSettlement(tx, {
      changedColumnIds: [input.columnId, ...changedFormulaIds],
      rowId: target.rowId,
      tableId: target.tableId,
      workspaceId: input.workspaceId,
    });
    const providerUnits = providerUnitsForRun(input.connectorId, input.output);
    if (providerUnits) {
      await tx
        .insert(usageLedger)
        .values({
          connectorId: input.connectorId,
          providerUnits,
          runId: input.runId,
          workspaceId: input.workspaceId,
        })
        .onConflictDoNothing({ target: usageLedger.runId });
    }
  });
}

export async function setSqliteCellRunFailure(
  db: SqliteDatabase,
  input: CellRunInput & {
    errorCode: string;
    errorMessage: string;
    retrying: boolean;
  }
): Promise<void> {
  await withSqliteWriteTransaction(db, async (tx) => {
    const now = new Date();
    const [target] = await tx
      .select({ rowId: cells.rowId, tableId: cells.tableId })
      .from(cells)
      .where(
        and(
          eq(cells.id, input.cellId),
          eq(cells.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
    const [failedRun] = await tx
      .update(cellRuns)
      .set({
        errorCode: safeError(input.errorCode, 80),
        errorMessage: safeError(input.errorMessage, 500),
        finishedAt: input.retrying ? null : now,
        status: input.retrying ? 'queued' : 'failed',
        updatedAt: now,
      })
      .where(
        and(runScope(input), inArray(cellRuns.status, ['queued', 'running']))
      )
      .returning({ id: cellRuns.id });
    await tx
      .update(cells)
      .set({ status: input.retrying ? 'queued' : 'failed', updatedAt: now })
      .where(
        and(
          eq(cells.id, input.cellId),
          eq(cells.workspaceId, input.workspaceId)
        )
      );
    if (!input.retrying && failedRun && target) {
      await recordSqliteRowMutationAndMaybeQueueSettlement(tx, {
        changedColumnIds: [input.columnId],
        rowId: target.rowId,
        tableId: target.tableId,
        workspaceId: input.workspaceId,
      });
    }
  });
}

async function queueConnectorActionRun(
  tx: SqliteTransaction,
  input: EnrichmentTargetScope & {
    dispatch: boolean;
    mode: BulkRunMode;
    runId: string;
  }
): Promise<CellRunInput> {
  const [target] = await tx
    .select({ configuration: columns.configuration })
    .from(columns)
    .innerJoin(
      rows,
      and(
        eq(rows.id, input.rowId),
        eq(rows.tableId, columns.tableId),
        eq(rows.workspaceId, columns.workspaceId)
      )
    )
    .innerJoin(
      dataTables,
      and(
        eq(dataTables.id, columns.tableId),
        eq(dataTables.workspaceId, columns.workspaceId)
      )
    )
    .where(
      and(
        eq(columns.id, input.columnId),
        eq(columns.kind, 'connector'),
        eq(columns.tableId, input.tableId),
        eq(columns.workspaceId, input.workspaceId),
        isNull(rows.archivedAt),
        isNull(columns.archivedAt),
        isNull(dataTables.archivedAt)
      )
    )
    .limit(1);
  if (!target) {
    throw new SqliteEnrichmentAccessError(
      'The enrichment cell is unavailable.'
    );
  }
  const waterfallConfiguration =
    httpWaterfallColumnConfigurationSchema.safeParse(target.configuration);
  if (waterfallConfiguration.success) {
    return queueSqliteHttpWaterfallRun(tx, input, waterfallConfiguration.data);
  }
  const httpConfiguration = httpEnrichmentColumnConfigurationSchema.safeParse(
    target.configuration
  );
  if (httpConfiguration.success) {
    return queueSqliteHttpRun(tx, input, httpConfiguration.data);
  }
  const configuration = connectorActionColumnConfigurationSchema.safeParse(
    target.configuration
  );
  if (!configuration.success) {
    throw new SqliteEnrichmentValidationError(
      'The enrichment column configuration is invalid.'
    );
  }
  await requireSqliteConnectorExecutionAllowed(tx, input.workspaceId, {
    artifactSha256: configuration.data.artifactSha256,
    connectorId: configuration.data.connectorId,
    connectorVersion: configuration.data.connectorVersion,
    publisherKeyIds: configuration.data.publisherKeyIds,
  });
  if (configuration.data.credentialId) {
    const [credential] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.id, configuration.data.credentialId),
          eq(credentials.workspaceId, input.workspaceId),
          eq(credentials.connectorId, configuration.data.connectorId),
          isNull(credentials.revokedAt)
        )
      )
      .limit(1);
    if (!credential) {
      throw new SqliteEnrichmentValidationError(
        'The connector credential is missing or revoked.'
      );
    }
  }
  const bindings = Object.entries(configuration.data.inputBindings).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  const sourceColumnIds = [
    ...new Set(
      bindings.flatMap(([, binding]) =>
        binding.kind === 'column' ? [binding.columnId] : []
      )
    ),
  ];
  const sourceCells =
    sourceColumnIds.length === 0
      ? []
      : await tx
          .select()
          .from(cells)
          .where(
            and(
              eq(cells.rowId, input.rowId),
              inArray(cells.columnId, sourceColumnIds),
              eq(cells.tableId, input.tableId),
              eq(cells.workspaceId, input.workspaceId)
            )
          );
  const sourceByColumn = new Map(
    sourceCells.map((cell) => [cell.columnId, cell])
  );
  const actionInput: Record<string, unknown> = {};
  for (const [key, binding] of bindings) {
    if (binding.kind === 'literal') {
      actionInput[key] = binding.value;
      continue;
    }
    const source = sourceByColumn.get(binding.columnId);
    if (!source || source.valueType === 'empty') {
      throw new SqliteEnrichmentValidationError(
        `The ${key} source cell must contain a value before enrichment.`
      );
    }
    actionInput[key] = readSourceCellValue(source);
  }
  const inputFingerprint = createHash('sha256')
    .update(JSON.stringify(actionInput))
    .digest('hex');
  const targetCell = await prepareTargetCell(tx, input);
  const durableInput: CellRunInput = {
    cellId: targetCell.id,
    columnId: input.columnId,
    credentialId: configuration.data.credentialId,
    inputFingerprint,
    rowId: input.rowId,
    runId: input.runId,
    workspaceId: input.workspaceId,
  };
  await tx.insert(cellRuns).values({
    actionId: configuration.data.actionId,
    allowedHosts: [],
    artifactSha256: configuration.data.artifactSha256,
    cellId: targetCell.id,
    connectorId: configuration.data.connectorId,
    connectorVersion: configuration.data.connectorVersion,
    credentialId: configuration.data.credentialId,
    id: input.runId,
    input: actionInput,
    inputFingerprint,
    publisherKeyIds: configuration.data.publisherKeyIds,
    registrySha256: configuration.data.registrySha256,
    workspaceId: input.workspaceId,
  });
  if (input.dispatch) {
    await tx.insert(outboxEvents).values({
      aggregateId: input.runId,
      aggregateType: 'cell_run',
      eventType: 'cell.run_requested',
      payload: durableInput,
      workspaceId: input.workspaceId,
    });
  }
  return durableInput;
}

async function queueSqliteHttpRun(
  tx: SqliteTransaction,
  input: EnrichmentTargetScope & {
    dispatch: boolean;
    mode: BulkRunMode;
    runId: string;
  },
  configuration: ReturnType<
    typeof httpEnrichmentColumnConfigurationSchema.parse
  >
): Promise<CellRunInput> {
  if (configuration.credentialId) {
    const [credential] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.id, configuration.credentialId),
          eq(credentials.workspaceId, input.workspaceId),
          eq(credentials.connectorId, 'http'),
          isNull(credentials.revokedAt)
        )
      )
      .limit(1);
    if (!credential) {
      throw new SqliteEnrichmentValidationError(
        'The enrichment credential is missing or revoked.'
      );
    }
  }
  const sourceCell = await requireSourceCell(tx, {
    ...input,
    sourceColumnId: configuration.inputColumnId,
  });
  const requestUrl = new URL(configuration.baseUrl);
  requestUrl.searchParams.set(
    configuration.queryParameter,
    serializeSourceCellValue(sourceCell)
  );
  const requestInput = { method: 'GET' as const, url: requestUrl.toString() };
  const inputFingerprint = createHash('sha256')
    .update(JSON.stringify(requestInput))
    .digest('hex');
  const targetCell = await prepareTargetCell(tx, input);
  const durableInput: CellRunInput = {
    cellId: targetCell.id,
    columnId: input.columnId,
    credentialId: configuration.credentialId,
    inputFingerprint,
    rowId: input.rowId,
    runId: input.runId,
    workspaceId: input.workspaceId,
  };
  await tx.insert(cellRuns).values({
    actionId: configuration.actionId,
    allowedHosts: [requestUrl.hostname.toLowerCase()],
    cellId: targetCell.id,
    connectorId: configuration.connectorId,
    credentialId: configuration.credentialId,
    id: input.runId,
    input: requestInput,
    inputFingerprint,
    workspaceId: input.workspaceId,
  });
  if (input.dispatch) await insertCellRunOutboxEvent(tx, durableInput);
  return durableInput;
}

async function queueSqliteHttpWaterfallRun(
  tx: SqliteTransaction,
  input: EnrichmentTargetScope & {
    dispatch: boolean;
    mode: BulkRunMode;
    runId: string;
  },
  configuration: ReturnType<typeof httpWaterfallColumnConfigurationSchema.parse>
): Promise<CellRunInput> {
  const credentialIds = [
    ...new Set(
      configuration.providers.flatMap((provider) =>
        provider.credentialId ? [provider.credentialId] : []
      )
    ),
  ];
  if (credentialIds.length > 0) {
    const activeCredentials = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          inArray(credentials.id, credentialIds),
          eq(credentials.workspaceId, input.workspaceId),
          eq(credentials.connectorId, 'http'),
          isNull(credentials.revokedAt)
        )
      );
    if (activeCredentials.length !== credentialIds.length) {
      throw new SqliteEnrichmentValidationError(
        'A waterfall credential is missing or revoked.'
      );
    }
  }
  const sourceCell = await requireSourceCell(tx, {
    ...input,
    sourceColumnId: configuration.inputColumnId,
  });
  const sourceValue = serializeSourceCellValue(sourceCell);
  const providers = configuration.providers.map((provider) => {
    const requestUrl = new URL(provider.baseUrl);
    requestUrl.searchParams.set(provider.queryParameter, sourceValue);
    return {
      credentialId: provider.credentialId,
      name: provider.name,
      providerId: provider.id,
      resultPath: provider.resultPath,
      url: requestUrl.toString(),
    };
  });
  const runPlan = {
    kind: 'http_waterfall' as const,
    providers,
    version: 1 as const,
  };
  const inputFingerprint = createHash('sha256')
    .update(JSON.stringify(runPlan))
    .digest('hex');
  const targetCell = await prepareTargetCell(tx, input);
  const durableInput: CellRunInput = {
    cellId: targetCell.id,
    columnId: input.columnId,
    credentialId: null,
    inputFingerprint,
    rowId: input.rowId,
    runId: input.runId,
    workspaceId: input.workspaceId,
  };
  await tx.insert(cellRuns).values({
    actionId: 'execute',
    allowedHosts: [
      ...new Set(
        providers.map((provider) =>
          new URL(provider.url).hostname.toLowerCase()
        )
      ),
    ],
    cellId: targetCell.id,
    connectorId: 'http_waterfall',
    credentialId: null,
    id: input.runId,
    input: runPlan,
    inputFingerprint,
    workspaceId: input.workspaceId,
  });
  if (input.dispatch) await insertCellRunOutboxEvent(tx, durableInput);
  return durableInput;
}

async function requireSourceCell(
  tx: SqliteTransaction,
  input: EnrichmentTargetScope & { sourceColumnId: string }
): Promise<typeof cells.$inferSelect> {
  const [sourceCell] = await tx
    .select()
    .from(cells)
    .where(
      and(
        eq(cells.rowId, input.rowId),
        eq(cells.columnId, input.sourceColumnId),
        eq(cells.tableId, input.tableId),
        eq(cells.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!sourceCell || sourceCell.valueType === 'empty') {
    throw new SqliteEnrichmentValidationError(
      'The source cell must contain a value before enrichment.'
    );
  }
  return sourceCell;
}

async function insertCellRunOutboxEvent(
  tx: SqliteTransaction,
  input: CellRunInput
): Promise<void> {
  await tx.insert(outboxEvents).values({
    aggregateId: input.runId,
    aggregateType: 'cell_run',
    eventType: 'cell.run_requested',
    payload: input,
    workspaceId: input.workspaceId,
  });
}

async function prepareTargetCell(
  tx: SqliteTransaction,
  input: EnrichmentTargetScope
): Promise<{ id: string }> {
  let created = false;
  let [target] = await tx
    .select({ id: cells.id, status: cells.status })
    .from(cells)
    .where(
      and(
        eq(cells.rowId, input.rowId),
        eq(cells.columnId, input.columnId),
        eq(cells.tableId, input.tableId),
        eq(cells.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!target) {
    [target] = await tx
      .insert(cells)
      .values({
        columnId: input.columnId,
        rowId: input.rowId,
        status: 'queued',
        tableId: input.tableId,
        valueType: 'empty',
        workspaceId: input.workspaceId,
      })
      .onConflictDoNothing({ target: [cells.rowId, cells.columnId] })
      .returning({ id: cells.id, status: cells.status });
    created = target !== undefined;
  }
  if (!target) {
    [target] = await tx
      .select({ id: cells.id, status: cells.status })
      .from(cells)
      .where(
        and(
          eq(cells.rowId, input.rowId),
          eq(cells.columnId, input.columnId),
          eq(cells.tableId, input.tableId),
          eq(cells.workspaceId, input.workspaceId)
        )
      )
      .limit(1);
  }
  if (!target) throw new Error('The target cell could not be created.');
  if (!created && (target.status === 'queued' || target.status === 'running')) {
    throw new SqliteEnrichmentConflictError(
      'This enrichment cell already has an active run.'
    );
  }
  if (!created) {
    await tx
      .update(cells)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(cells.id, target.id));
  }
  return target;
}

async function loadExistingRun(
  tx: SqliteTransaction,
  input: {
    columnId: string;
    rowId: string;
    runId: string;
    workspaceId: string;
  }
): Promise<CellRunInput | null> {
  const [existing] = await tx
    .select({ run: cellRuns, cell: cells })
    .from(cellRuns)
    .innerJoin(
      cells,
      and(
        eq(cells.id, cellRuns.cellId),
        eq(cells.workspaceId, cellRuns.workspaceId)
      )
    )
    .where(
      and(
        eq(cellRuns.id, input.runId),
        eq(cellRuns.workspaceId, input.workspaceId),
        eq(cells.rowId, input.rowId),
        eq(cells.columnId, input.columnId)
      )
    )
    .limit(1);
  if (!existing) return null;
  return {
    cellId: existing.run.cellId,
    columnId: input.columnId,
    credentialId: existing.run.credentialId,
    inputFingerprint: existing.run.inputFingerprint,
    rowId: input.rowId,
    runId: input.runId,
    workspaceId: input.workspaceId,
  };
}

async function requireTablePermission(
  db: Pick<SqliteDatabase, 'select'> | SqliteTransaction,
  input: EnrichmentScope,
  permission: 'data.write' | 'schema.manage'
): Promise<void> {
  const [record] = await db
    .select({ role: workspaceMembers.role })
    .from(dataTables)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, dataTables.workspaceId),
        eq(workspaceMembers.userId, input.userId)
      )
    )
    .where(
      and(
        eq(dataTables.id, input.tableId),
        eq(dataTables.workspaceId, input.workspaceId),
        isNull(dataTables.archivedAt)
      )
    )
    .limit(1);
  if (!record || !hasWorkspacePermission(record.role, permission)) {
    throw new SqliteEnrichmentAccessError('The table is not accessible.');
  }
}

function deterministicCellRunId(input: {
  columnId: string;
  rowId: string;
  runId: string;
  stepId: string;
}): string {
  const bytes = createHash('sha256')
    .update(
      `${input.runId}\0${input.stepId}\0${input.columnId}\0${input.rowId}`
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readSourceCellValue(cell: typeof cells.$inferSelect): unknown {
  switch (cell.valueType) {
    case 'text':
      return cell.valueText ?? '';
    case 'number':
      return cell.valueNumber ?? 0;
    case 'boolean':
      return cell.valueBoolean ?? false;
    case 'timestamp':
      return cell.valueTimestamp?.toISOString() ?? null;
    case 'json':
      return cell.valueJson;
    case 'empty':
      throw new SqliteEnrichmentValidationError('The source cell is empty.');
  }
}

function serializeSourceCellValue(cell: typeof cells.$inferSelect): string {
  const value = readSourceCellValue(cell);
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function assertCredentialFreeHttpsUrl(urlValue: string, label: string): void {
  const url = new URL(urlValue);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new SqliteEnrichmentValidationError(
      `${label} must be credential-free HTTPS URLs.`
    );
  }
}

function runScope(input: CellRunInput) {
  return and(
    eq(cellRuns.id, input.runId),
    eq(cellRuns.workspaceId, input.workspaceId),
    eq(cellRuns.cellId, input.cellId),
    eq(cellRuns.inputFingerprint, input.inputFingerprint)
  )!;
}

function providerUnitsForRun(
  connectorId: string,
  output: unknown
): string | null {
  if (connectorId !== 'openai' || !output || typeof output !== 'object')
    return null;
  const usage = (output as { usage?: unknown }).usage;
  return usage && typeof usage === 'object' ? JSON.stringify(usage) : null;
}

function safeError(value: string, maximum: number): string {
  return value.replace(/[\r\n\t]/g, ' ').slice(0, maximum);
}
