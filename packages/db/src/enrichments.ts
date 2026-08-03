import {
  connectorActionColumnConfigurationSchema,
  httpEnrichmentColumnConfigurationSchema,
  httpWaterfallColumnConfigurationSchema,
  type CellRunInput,
  type ConnectorRunMode,
  type ConnectorActionInputBinding,
} from '@byok-grid/domain';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Database } from './client';
import { requireConnectorExecutionAllowed } from './connector-revocations';
import {
  cellRuns,
  cells,
  columnDependencies,
  columns,
  credentials,
  dataTables,
  outboxEvents,
  rows,
  workspaceMembers,
} from './schema';

export class EnrichmentAccessError extends Error {}
export class EnrichmentValidationError extends Error {}

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

type EnrichmentExecutor = Pick<Database, 'insert' | 'select' | 'update'>;

export async function createConnectorActionColumn(
  db: Database,
  input: EnrichmentScope & {
    actionId: string;
    artifactSha256?: string | null;
    connectorId: string;
    connectorVersion?: string;
    credentialId: string | null;
    inputBindings: Readonly<Record<string, ConnectorActionInputBinding>>;
    name: string;
    outputValueType: 'boolean' | 'json' | 'number' | 'text';
    publisherKeyIds?: readonly string[];
    registrySha256?: string | null;
    protocolVersion: '1.0' | '1.1';
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
    throw new EnrichmentValidationError(
      'Column names must contain 1 to 120 characters.'
    );
  }
  const sourceColumnIds = [
    ...new Set(
      Object.values(configuration.inputBindings)
        .map((binding) => (binding.kind === 'column' ? binding.columnId : null))
        .filter((columnId): columnId is string => columnId !== null)
    ),
  ];

  return db.transaction(async (tx) => {
    await requireConnectorExecutionAllowed(tx, input.workspaceId, {
      artifactSha256: configuration.artifactSha256,
      connectorId: configuration.connectorId,
      connectorVersion: configuration.connectorVersion,
      publisherKeyIds: configuration.publisherKeyIds,
    });
    const accessibleColumns =
      sourceColumnIds.length === 0
        ? []
        : await tx
            .select({ id: columns.id })
            .from(columns)
            .innerJoin(
              dataTables,
              and(
                eq(dataTables.id, columns.tableId),
                eq(dataTables.workspaceId, columns.workspaceId)
              )
            )
            .innerJoin(
              workspaceMembers,
              and(
                eq(workspaceMembers.workspaceId, columns.workspaceId),
                eq(workspaceMembers.userId, input.userId)
              )
            )
            .where(
              and(
                inArray(columns.id, sourceColumnIds),
                eq(columns.tableId, input.tableId),
                eq(columns.workspaceId, input.workspaceId),
                isNull(columns.archivedAt),
                isNull(dataTables.archivedAt)
              )
            );
    if (accessibleColumns.length !== sourceColumnIds.length) {
      throw new EnrichmentAccessError(
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
        throw new EnrichmentAccessError(
          'The connector credential is not accessible.'
        );
      }
    }

    const [created] = await tx
      .insert(columns)
      .values({
        configuration,
        kind: 'connector',
        name,
        position: `z-${Date.now()}-${crypto.randomUUID()}`,
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
    if (!created) {
      throw new Error('The connector column could not be created.');
    }

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

export async function createHttpWaterfallColumn(
  db: Database,
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
    const url = new URL(provider.baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new EnrichmentValidationError(
        'Waterfall endpoints must be credential-free HTTPS URLs.'
      );
    }
  }
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new EnrichmentValidationError(
      'Column names must contain 1 to 120 characters.'
    );
  }

  return db.transaction(async (tx) => {
    const [sourceColumn] = await tx
      .select({ id: columns.id })
      .from(columns)
      .innerJoin(
        dataTables,
        and(
          eq(dataTables.id, columns.tableId),
          eq(dataTables.workspaceId, columns.workspaceId)
        )
      )
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, columns.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .where(
        and(
          eq(columns.id, input.inputColumnId),
          inArray(columns.kind, ['input', 'formula', 'connector']),
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt),
          isNull(dataTables.archivedAt)
        )
      )
      .limit(1);
    if (!sourceColumn) {
      throw new EnrichmentAccessError('The source column is not accessible.');
    }

    const credentialIds = [
      ...new Set(
        configuration.providers.flatMap((provider) =>
          provider.credentialId ? [provider.credentialId] : []
        )
      ),
    ];
    if (credentialIds.length > 0) {
      const availableCredentials = await tx
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
      if (availableCredentials.length !== credentialIds.length) {
        throw new EnrichmentAccessError(
          'One or more waterfall credentials are not accessible.'
        );
      }
    }

    const [created] = await tx
      .insert(columns)
      .values({
        configuration,
        kind: 'connector',
        name,
        position: `z-${Date.now()}-${crypto.randomUUID()}`,
        tableId: input.tableId,
        valueType: 'json',
        workspaceId: input.workspaceId,
      })
      .returning({
        id: columns.id,
        kind: columns.kind,
        name: columns.name,
        position: columns.position,
        valueType: columns.valueType,
      });
    if (!created) throw new Error('The waterfall column could not be created.');

    await tx.insert(columnDependencies).values({
      columnId: created.id,
      dependsOnColumnId: sourceColumn.id,
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    });
    return created;
  });
}

export async function createHttpEnrichmentColumn(
  db: Database,
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
  const url = new URL(configuration.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new EnrichmentValidationError(
      'Enrichment endpoints must be credential-free HTTPS URLs.'
    );
  }
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw new EnrichmentValidationError(
      'Column names must contain 1 to 120 characters.'
    );
  }

  return db.transaction(async (tx) => {
    const [sourceColumn] = await tx
      .select({ id: columns.id })
      .from(columns)
      .innerJoin(
        dataTables,
        and(
          eq(dataTables.id, columns.tableId),
          eq(dataTables.workspaceId, columns.workspaceId)
        )
      )
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, columns.workspaceId),
          eq(workspaceMembers.userId, input.userId)
        )
      )
      .where(
        and(
          eq(columns.id, input.inputColumnId),
          inArray(columns.kind, ['input', 'formula', 'connector']),
          eq(columns.tableId, input.tableId),
          eq(columns.workspaceId, input.workspaceId),
          isNull(columns.archivedAt),
          isNull(dataTables.archivedAt)
        )
      )
      .limit(1);
    if (!sourceColumn) {
      throw new EnrichmentAccessError('The source column is not accessible.');
    }

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
        throw new EnrichmentAccessError('The credential is not accessible.');
      }
    }

    const [created] = await tx
      .insert(columns)
      .values({
        configuration,
        kind: 'connector',
        name,
        position: `z-${Date.now()}-${crypto.randomUUID()}`,
        tableId: input.tableId,
        valueType: 'json',
        workspaceId: input.workspaceId,
      })
      .returning({
        id: columns.id,
        kind: columns.kind,
        name: columns.name,
        position: columns.position,
        valueType: columns.valueType,
      });
    if (!created)
      throw new Error('The enrichment column could not be created.');

    await tx.insert(columnDependencies).values({
      columnId: created.id,
      dependsOnColumnId: sourceColumn.id,
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    });
    return created;
  });
}

export async function queueEnrichmentCellRun(
  db: Database,
  input: EnrichmentScope & { columnId: string; rowId: string }
): Promise<{ cellId: string; runId: string; status: 'queued' }> {
  return db.transaction((tx) => queueEnrichmentCellRunInTransaction(tx, input));
}

export async function queueEnrichmentCellRunInTransaction(
  tx: EnrichmentExecutor,
  input: EnrichmentScope & { columnId: string; rowId: string }
): Promise<{ cellId: string; runId: string; status: 'queued' }> {
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
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, columns.workspaceId),
        eq(workspaceMembers.userId, input.userId)
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
    throw new EnrichmentAccessError('The enrichment cell is not accessible.');
  }

  return queueEnrichmentCellRunForConfiguration(
    tx,
    input,
    target.configuration
  );
}

export async function queueAutomaticEnrichmentCellRunInTransaction(
  tx: EnrichmentExecutor,
  input: EnrichmentTargetScope
): Promise<{ cellId: string; runId: string; status: 'queued' }> {
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
    throw new EnrichmentAccessError(
      'The automatic enrichment cell is invalid.'
    );
  }
  return queueEnrichmentCellRunForConfiguration(
    tx,
    input,
    target.configuration
  );
}

async function queueEnrichmentCellRunForConfiguration(
  tx: EnrichmentExecutor,
  input: EnrichmentTargetScope,
  rawConfiguration: Readonly<Record<string, unknown>>
): Promise<{ cellId: string; runId: string; status: 'queued' }> {
  const waterfallConfiguration =
    httpWaterfallColumnConfigurationSchema.safeParse(rawConfiguration);
  if (waterfallConfiguration.success) {
    return queueHttpWaterfallRun(tx, input, waterfallConfiguration.data);
  }

  const connectorActionConfiguration =
    connectorActionColumnConfigurationSchema.safeParse(rawConfiguration);
  if (connectorActionConfiguration.success) {
    return queueConnectorActionRun(
      tx,
      input,
      connectorActionConfiguration.data
    );
  }

  const configuration =
    httpEnrichmentColumnConfigurationSchema.safeParse(rawConfiguration);
  if (!configuration.success) {
    throw new EnrichmentValidationError(
      'The enrichment column configuration is invalid.'
    );
  }

  if (configuration.data.credentialId) {
    const [credential] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(
        and(
          eq(credentials.id, configuration.data.credentialId),
          eq(credentials.workspaceId, input.workspaceId),
          isNull(credentials.revokedAt)
        )
      )
      .limit(1);
    if (!credential) {
      throw new EnrichmentValidationError(
        'The enrichment credential is missing or revoked.'
      );
    }
  }

  const [sourceCell] = await tx
    .select()
    .from(cells)
    .where(
      and(
        eq(cells.rowId, input.rowId),
        eq(cells.columnId, configuration.data.inputColumnId),
        eq(cells.tableId, input.tableId),
        eq(cells.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!sourceCell || sourceCell.valueType === 'empty') {
    throw new EnrichmentValidationError(
      'The source cell must contain a value before enrichment.'
    );
  }

  const requestUrl = new URL(configuration.data.baseUrl);
  requestUrl.searchParams.set(
    configuration.data.queryParameter,
    serializeSourceValue(sourceCell)
  );
  const requestInput = { method: 'GET' as const, url: requestUrl.toString() };
  const inputFingerprint = createHash('sha256')
    .update(JSON.stringify(requestInput))
    .digest('hex');

  const targetCell = await prepareTargetCell(tx, input);

  const runId = crypto.randomUUID();
  const durableInput: CellRunInput = {
    cellId: targetCell.id,
    columnId: input.columnId,
    credentialId: configuration.data.credentialId,
    inputFingerprint,
    rowId: input.rowId,
    runId,
    workspaceId: input.workspaceId,
  };
  await tx.insert(cellRuns).values({
    actionId: configuration.data.actionId,
    allowedHosts: [requestUrl.hostname.toLowerCase()],
    cellId: targetCell.id,
    connectorId: configuration.data.connectorId,
    credentialId: configuration.data.credentialId,
    id: runId,
    input: requestInput,
    inputFingerprint,
    workspaceId: input.workspaceId,
  });
  await tx.insert(outboxEvents).values({
    aggregateId: runId,
    aggregateType: 'cell_run',
    eventType: 'cell.run_requested',
    payload: durableInput,
    workspaceId: input.workspaceId,
  });

  return { cellId: targetCell.id, runId, status: 'queued' };
}

export const queueHttpCellRun = queueEnrichmentCellRun;

async function queueConnectorActionRun(
  tx: EnrichmentExecutor,
  input: EnrichmentTargetScope,
  configuration: ReturnType<
    typeof connectorActionColumnConfigurationSchema.parse
  >
): Promise<{ cellId: string; runId: string; status: 'queued' }> {
  await requireConnectorExecutionAllowed(tx, input.workspaceId, {
    artifactSha256: configuration.artifactSha256,
    connectorId: configuration.connectorId,
    connectorVersion: configuration.connectorVersion,
    publisherKeyIds: configuration.publisherKeyIds,
  });
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
      throw new EnrichmentValidationError(
        'The connector credential is missing or revoked.'
      );
    }
  }

  const bindingEntries = Object.entries(configuration.inputBindings).sort(
    ([left], [right]) => left.localeCompare(right)
  );
  const sourceColumnIds = [
    ...new Set(
      bindingEntries.flatMap(([, binding]) =>
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
  const sourceCellsByColumn = new Map(
    sourceCells.map((cell) => [cell.columnId, cell])
  );
  const actionInput: Record<string, unknown> = {};
  for (const [inputKey, binding] of bindingEntries) {
    if (binding.kind === 'literal') {
      actionInput[inputKey] = binding.value;
      continue;
    }
    const sourceCell = sourceCellsByColumn.get(binding.columnId);
    if (!sourceCell || sourceCell.valueType === 'empty') {
      throw new EnrichmentValidationError(
        `The ${inputKey} source cell must contain a value before enrichment.`
      );
    }
    actionInput[inputKey] = readSourceCellValue(sourceCell);
  }
  const inputFingerprint = createHash('sha256')
    .update(JSON.stringify(actionInput))
    .digest('hex');

  const targetCell = await prepareTargetCell(tx, input);

  const runId = crypto.randomUUID();
  const durableInput: CellRunInput = {
    cellId: targetCell.id,
    columnId: input.columnId,
    credentialId: configuration.credentialId,
    inputFingerprint,
    rowId: input.rowId,
    runId,
    workspaceId: input.workspaceId,
  };
  await tx.insert(cellRuns).values({
    actionId: configuration.actionId,
    allowedHosts: [],
    artifactSha256: configuration.artifactSha256,
    cellId: targetCell.id,
    connectorId: configuration.connectorId,
    connectorVersion: configuration.connectorVersion,
    credentialId: configuration.credentialId,
    id: runId,
    input: actionInput,
    inputFingerprint,
    publisherKeyIds: configuration.publisherKeyIds,
    registrySha256: configuration.registrySha256,
    workspaceId: input.workspaceId,
  });
  await tx.insert(outboxEvents).values({
    aggregateId: runId,
    aggregateType: 'cell_run',
    eventType: 'cell.run_requested',
    payload: durableInput,
    workspaceId: input.workspaceId,
  });

  return { cellId: targetCell.id, runId, status: 'queued' };
}

async function queueHttpWaterfallRun(
  tx: EnrichmentExecutor,
  input: EnrichmentTargetScope,
  configuration: ReturnType<typeof httpWaterfallColumnConfigurationSchema.parse>
): Promise<{ cellId: string; runId: string; status: 'queued' }> {
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
      throw new EnrichmentValidationError(
        'A waterfall credential is missing or revoked.'
      );
    }
  }

  const [sourceCell] = await tx
    .select()
    .from(cells)
    .where(
      and(
        eq(cells.rowId, input.rowId),
        eq(cells.columnId, configuration.inputColumnId),
        eq(cells.tableId, input.tableId),
        eq(cells.workspaceId, input.workspaceId)
      )
    )
    .limit(1);
  if (!sourceCell || sourceCell.valueType === 'empty') {
    throw new EnrichmentValidationError(
      'The source cell must contain a value before enrichment.'
    );
  }
  const sourceValue = serializeSourceValue(sourceCell);
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

  const runId = crypto.randomUUID();
  const durableInput: CellRunInput = {
    cellId: targetCell.id,
    columnId: input.columnId,
    credentialId: null,
    inputFingerprint,
    rowId: input.rowId,
    runId,
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
    id: runId,
    input: runPlan,
    inputFingerprint,
    workspaceId: input.workspaceId,
  });
  await tx.insert(outboxEvents).values({
    aggregateId: runId,
    aggregateType: 'cell_run',
    eventType: 'cell.run_requested',
    payload: durableInput,
    workspaceId: input.workspaceId,
  });

  return { cellId: targetCell.id, runId, status: 'queued' };
}

async function prepareTargetCell(
  tx: EnrichmentExecutor,
  input: EnrichmentTargetScope
): Promise<{ id: string }> {
  let created = false;
  let [targetCell] = await tx
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
    .limit(1)
    .for('update');

  if (!targetCell) {
    [targetCell] = await tx
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
    created = targetCell !== undefined;
  }

  if (!targetCell) {
    [targetCell] = await tx
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
      .limit(1)
      .for('update');
  }
  if (!targetCell) throw new Error('The target cell could not be created.');
  if (
    !created &&
    (targetCell.status === 'queued' || targetCell.status === 'running')
  ) {
    throw new EnrichmentValidationError(
      'This enrichment cell already has an active run.'
    );
  }

  if (!created) {
    await tx
      .update(cells)
      .set({ status: 'queued', updatedAt: new Date() })
      .where(eq(cells.id, targetCell.id));
  }
  return { id: targetCell.id };
}

function serializeSourceValue(cell: typeof cells.$inferSelect): string {
  switch (cell.valueType) {
    case 'text':
      return cell.valueText ?? '';
    case 'number':
      return cell.valueNumber ?? '';
    case 'boolean':
      return String(cell.valueBoolean);
    case 'timestamp':
      return cell.valueTimestamp?.toISOString() ?? '';
    case 'json':
      return JSON.stringify(cell.valueJson);
    case 'empty':
      throw new EnrichmentValidationError('The source cell is empty.');
  }
}

function readSourceCellValue(cell: typeof cells.$inferSelect): unknown {
  switch (cell.valueType) {
    case 'text':
      return cell.valueText ?? '';
    case 'number':
      return Number(cell.valueNumber);
    case 'boolean':
      return cell.valueBoolean;
    case 'timestamp':
      return cell.valueTimestamp?.toISOString() ?? null;
    case 'json':
      return cell.valueJson;
    case 'empty':
      throw new EnrichmentValidationError('The source cell is empty.');
  }
}
