import {
  connectorActionColumnConfigurationSchema,
  decideAutomaticFanout,
  gridViewFilterLeaves,
  httpEnrichmentColumnConfigurationSchema,
  httpWaterfallColumnConfigurationSchema,
  MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE,
  normalizeGridViewFilterTree,
  rowSettlementInputSchema,
  type ConnectorRunMode,
  type RowSettlementInput,
} from '@byok-grid/domain';
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from './client';
import { queueAutomaticEnrichmentCellRunInTransaction } from './enrichments';
import { queueSettledWebhookDeliveries } from './webhooks';
import { queueSettledWritebackDeliveries } from './writebacks';
import {
  cells,
  columnDependencies,
  columns,
  outboxEvents,
  rows,
  rowSettlements,
  webhookDestinations,
  writebackDestinations,
} from './schema';

type RowAutomationExecutor = Pick<Database, 'insert' | 'select' | 'update'>;

export interface RowMutationScope {
  changedColumnIds: readonly string[];
  rowId: string;
  tableId: string;
  workspaceId: string;
}

export interface RowSettlementOptions {
  maximumAutomaticRuns?: number;
  maximumAutomaticWritebacks?: number;
}

export type RowSettlementResult = {
  queuedDeliveryCount: number;
  queuedRunCount: number;
  status: 'failed' | 'skipped' | 'succeeded';
};

export async function recordRowMutationAndMaybeQueueSettlement(
  db: RowAutomationExecutor,
  input: RowMutationScope
): Promise<{ rowVersion: number; settlementId: string | null }> {
  const now = new Date();
  const [row] = await db
    .update(rows)
    .set({
      updatedAt: now,
      version: sql`${rows.version} + 1`,
    })
    .where(
      and(
        eq(rows.id, input.rowId),
        eq(rows.tableId, input.tableId),
        eq(rows.workspaceId, input.workspaceId)
      )
    )
    .returning({ version: rows.version });
  if (!row) throw new Error('The mutated row does not exist.');

  const changedColumnIds = [...new Set(input.changedColumnIds)].sort();
  const [
    automaticWebhooks,
    automaticWritebacks,
    dependentConnectors,
    pendingDeliverySettlements,
  ] = await Promise.all([
    db
      .select({ id: webhookDestinations.id })
      .from(webhookDestinations)
      .where(
        and(
          eq(webhookDestinations.tableId, input.tableId),
          eq(webhookDestinations.workspaceId, input.workspaceId),
          eq(webhookDestinations.status, 'active'),
          eq(webhookDestinations.triggerMode, 'row_settled')
        )
      )
      .limit(1),
    db
      .select({
        fieldMappings: writebackDestinations.fieldMappings,
        filterTree: writebackDestinations.filterTree,
        recordIdColumnId: writebackDestinations.recordIdColumnId,
      })
      .from(writebackDestinations)
      .where(
        and(
          eq(writebackDestinations.tableId, input.tableId),
          eq(writebackDestinations.workspaceId, input.workspaceId),
          eq(writebackDestinations.status, 'active'),
          eq(writebackDestinations.triggerMode, 'row_settled')
        )
      )
      .limit(MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE),
    changedColumnIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ configuration: columns.configuration })
          .from(columnDependencies)
          .innerJoin(
            columns,
            and(
              eq(columns.id, columnDependencies.columnId),
              eq(columns.tableId, columnDependencies.tableId),
              eq(columns.workspaceId, columnDependencies.workspaceId)
            )
          )
          .where(
            and(
              inArray(columnDependencies.dependsOnColumnId, changedColumnIds),
              eq(columnDependencies.tableId, input.tableId),
              eq(columnDependencies.workspaceId, input.workspaceId),
              eq(columns.kind, 'connector')
            )
          ),
    db
      .select({ id: rowSettlements.id })
      .from(rowSettlements)
      .where(
        and(
          eq(rowSettlements.rowId, input.rowId),
          eq(rowSettlements.tableId, input.tableId),
          eq(rowSettlements.workspaceId, input.workspaceId),
          eq(rowSettlements.status, 'succeeded'),
          gt(rowSettlements.queuedRunCount, 0),
          isNull(rowSettlements.consumedById)
        )
      )
      .limit(1),
  ]);
  const hasAutomaticDependent = dependentConnectors.some(
    ({ configuration }) => readConnectorRunMode(configuration) === 'on_change'
  );
  const changedColumnIdSet = new Set(changedColumnIds);
  const hasRelevantAutomaticWriteback = automaticWritebacks.some(
    (destination) =>
      [
        destination.recordIdColumnId,
        ...destination.fieldMappings.map((mapping) => mapping.columnId),
        ...gridViewFilterLeaves(
          normalizeGridViewFilterTree(destination.filterTree)
        ).map((filter) => filter.columnId),
      ].some((columnId) => changedColumnIdSet.has(columnId))
  );
  if (
    automaticWebhooks.length === 0 &&
    !hasRelevantAutomaticWriteback &&
    !hasAutomaticDependent &&
    pendingDeliverySettlements.length === 0
  ) {
    return { rowVersion: row.version, settlementId: null };
  }

  const settlementId = crypto.randomUUID();
  const [settlement] = await db
    .insert(rowSettlements)
    .values({
      changedColumnIds,
      id: settlementId,
      rowId: input.rowId,
      rowVersion: row.version,
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    })
    .onConflictDoNothing()
    .returning({ id: rowSettlements.id });
  if (!settlement) return { rowVersion: row.version, settlementId: null };

  const workerInput = rowSettlementInputSchema.parse({
    rowId: input.rowId,
    rowVersion: row.version,
    settlementId: settlement.id,
    tableId: input.tableId,
    workspaceId: input.workspaceId,
  });
  await db.insert(outboxEvents).values({
    aggregateId: settlement.id,
    aggregateType: 'row_settlement',
    eventType: 'table.row_settled',
    payload: workerInput,
    workspaceId: input.workspaceId,
  });
  return { rowVersion: row.version, settlementId: settlement.id };
}

export async function processRowSettlement(
  db: Database,
  rawInput: RowSettlementInput,
  options: RowSettlementOptions = {}
): Promise<RowSettlementResult> {
  const input = rowSettlementInputSchema.parse(rawInput);
  const maximumAutomaticRuns = options.maximumAutomaticRuns ?? 10;
  const maximumAutomaticWritebacks = options.maximumAutomaticWritebacks ?? 5;
  if (!Number.isInteger(maximumAutomaticRuns) || maximumAutomaticRuns < 1) {
    throw new Error('The automatic enrichment fan-out limit is invalid.');
  }
  if (
    !Number.isInteger(maximumAutomaticWritebacks) ||
    maximumAutomaticWritebacks < 1
  ) {
    throw new Error('The automatic writeback fan-out limit is invalid.');
  }
  return db.transaction(async (tx) => {
    // Lock the row before any settlement so concurrent events for one row use
    // a single canonical lock order and cannot deadlock while coalescing.
    const [currentRow] = await tx
      .select({ archivedAt: rows.archivedAt, version: rows.version })
      .from(rows)
      .where(
        and(
          eq(rows.id, input.rowId),
          eq(rows.tableId, input.tableId),
          eq(rows.workspaceId, input.workspaceId)
        )
      )
      .limit(1)
      .for('update');
    if (!currentRow) throw new Error('The settled row does not exist.');

    const [settlement] = await tx
      .select()
      .from(rowSettlements)
      .where(
        and(
          eq(rowSettlements.id, input.settlementId),
          eq(rowSettlements.rowId, input.rowId),
          eq(rowSettlements.rowVersion, input.rowVersion),
          eq(rowSettlements.tableId, input.tableId),
          eq(rowSettlements.workspaceId, input.workspaceId)
        )
      )
      .limit(1)
      .for('update');
    if (!settlement) throw new Error('The row settlement does not exist.');
    if (settlement.status === 'succeeded') {
      return {
        queuedDeliveryCount: settlement.queuedDeliveryCount,
        queuedRunCount: settlement.queuedRunCount,
        status: 'succeeded' as const,
      };
    }
    if (settlement.status === 'skipped') {
      return {
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'skipped' as const,
      };
    }
    if (settlement.status === 'failed') {
      throw new Error('The row settlement has permanently failed.');
    }

    const now = new Date();
    await tx
      .update(rowSettlements)
      .set({
        errorMessage: null,
        startedAt: now,
        status: 'running',
        updatedAt: now,
      })
      .where(eq(rowSettlements.id, settlement.id));

    if (
      currentRow.archivedAt !== null ||
      currentRow.version !== input.rowVersion
    ) {
      await tx
        .update(rowSettlements)
        .set({ finishedAt: now, status: 'skipped', updatedAt: now })
        .where(eq(rowSettlements.id, settlement.id));
      return {
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'skipped' as const,
      };
    }

    const candidates = await tx
      .select()
      .from(rowSettlements)
      .where(
        and(
          eq(rowSettlements.rowId, input.rowId),
          eq(rowSettlements.tableId, input.tableId),
          eq(rowSettlements.workspaceId, input.workspaceId),
          lte(rowSettlements.rowVersion, input.rowVersion),
          isNull(rowSettlements.consumedById)
        )
      )
      .for('update');
    const deliveryChangedColumnIds = [
      ...new Set(candidates.flatMap((candidate) => candidate.changedColumnIds)),
    ].sort();
    const changedColumnIds = [
      ...new Set(
        candidates
          .filter((candidate) => candidate.queuedRunCount === 0)
          .flatMap((candidate) => candidate.changedColumnIds)
      ),
    ].sort();

    const dependentColumns =
      changedColumnIds.length === 0
        ? []
        : await tx
            .select({
              configuration: columns.configuration,
              id: columns.id,
            })
            .from(columnDependencies)
            .innerJoin(
              columns,
              and(
                eq(columns.id, columnDependencies.columnId),
                eq(columns.tableId, columnDependencies.tableId),
                eq(columns.workspaceId, columnDependencies.workspaceId)
              )
            )
            .where(
              and(
                inArray(columnDependencies.dependsOnColumnId, changedColumnIds),
                eq(columnDependencies.tableId, input.tableId),
                eq(columnDependencies.workspaceId, input.workspaceId),
                eq(columns.kind, 'connector')
              )
            );
    const automaticColumnIds = [
      ...new Set(
        dependentColumns.flatMap((column) =>
          readConnectorRunMode(column.configuration) === 'on_change'
            ? [column.id]
            : []
        )
      ),
    ];
    const existingTargetCells =
      automaticColumnIds.length === 0
        ? []
        : await tx
            .select({ columnId: cells.columnId, status: cells.status })
            .from(cells)
            .where(
              and(
                eq(cells.rowId, input.rowId),
                inArray(cells.columnId, automaticColumnIds),
                eq(cells.tableId, input.tableId),
                eq(cells.workspaceId, input.workspaceId)
              )
            );
    const activeAutomaticColumnIds = new Set(
      existingTargetCells.flatMap((cell) =>
        cell.status === 'queued' || cell.status === 'running'
          ? [cell.columnId]
          : []
      )
    );
    const candidateIds = candidates.map((candidate) => candidate.id);
    if (activeAutomaticColumnIds.size > 0) {
      // Keep every dirty set unconsumed. The active run may have frozen older
      // inputs; its terminal mutation will wake a later settlement that can
      // rerun the complete dependency wave against current values.
      await tx
        .update(rowSettlements)
        .set({ finishedAt: now, status: 'skipped', updatedAt: now })
        .where(eq(rowSettlements.id, settlement.id));
      return {
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'skipped' as const,
      };
    }
    const decision = decideAutomaticFanout(
      automaticColumnIds,
      maximumAutomaticRuns
    );

    if (decision.kind === 'blocked') {
      await consumeCandidateSettlements(tx, candidateIds, settlement.id, now);
      await tx
        .update(rowSettlements)
        .set({
          consumedById: settlement.id,
          errorMessage: `Automatic enrichment fan-out of ${decision.candidateCount} exceeds the per-row limit of ${decision.limit}.`,
          finishedAt: now,
          status: 'failed',
          updatedAt: now,
        })
        .where(eq(rowSettlements.id, settlement.id));
      return {
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'failed' as const,
      };
    }

    for (const columnId of decision.columnIds) {
      await queueAutomaticEnrichmentCellRunInTransaction(tx, {
        columnId,
        rowId: input.rowId,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      });
    }
    if (decision.columnIds.length > 0) {
      await consumeCandidateSettlements(
        tx,
        candidateIds.filter((candidateId) => candidateId !== settlement.id),
        settlement.id,
        now
      );
      await tx
        .update(rowSettlements)
        .set({
          changedColumnIds: deliveryChangedColumnIds,
          consumedById: null,
          finishedAt: now,
          queuedRunCount: decision.columnIds.length,
          status: 'succeeded',
          updatedAt: now,
        })
        .where(eq(rowSettlements.id, settlement.id));
      return {
        queuedDeliveryCount: 0,
        queuedRunCount: decision.columnIds.length,
        status: 'succeeded' as const,
      };
    }

    const activeCells = await tx
      .select({ id: cells.id })
      .from(cells)
      .where(
        and(
          eq(cells.rowId, input.rowId),
          eq(cells.tableId, input.tableId),
          eq(cells.workspaceId, input.workspaceId),
          inArray(cells.status, ['queued', 'running'])
        )
      )
      .limit(1);
    if (activeCells.length > 0) {
      await tx
        .update(rowSettlements)
        .set({ finishedAt: now, status: 'skipped', updatedAt: now })
        .where(eq(rowSettlements.id, settlement.id));
      return {
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'skipped' as const,
      };
    }

    const writebackResult = await queueSettledWritebackDeliveries(
      tx as unknown as Database,
      {
        changedColumnIds: deliveryChangedColumnIds,
        maximumAutomaticWritebacks,
        rowId: input.rowId,
        rowVersion: input.rowVersion,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      }
    );
    if (writebackResult.kind === 'blocked') {
      await consumeCandidateSettlements(tx, candidateIds, settlement.id, now);
      await tx
        .update(rowSettlements)
        .set({
          consumedById: settlement.id,
          errorMessage: `Automatic writeback fan-out of ${writebackResult.candidateCount} exceeds the per-row limit of ${writebackResult.limit}.`,
          finishedAt: now,
          status: 'failed',
          updatedAt: now,
        })
        .where(eq(rowSettlements.id, settlement.id));
      return {
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'failed' as const,
      };
    }
    const queuedWebhookCount = await queueSettledWebhookDeliveries(
      tx as unknown as Database,
      input
    );
    const queuedDeliveryCount =
      writebackResult.queuedCount + queuedWebhookCount;
    await consumeCandidateSettlements(tx, candidateIds, settlement.id, now);
    await tx
      .update(rowSettlements)
      .set({
        consumedById: settlement.id,
        finishedAt: now,
        queuedDeliveryCount,
        status: 'succeeded',
        updatedAt: now,
      })
      .where(eq(rowSettlements.id, settlement.id));
    return {
      queuedDeliveryCount,
      queuedRunCount: 0,
      status: 'succeeded' as const,
    };
  });
}

async function consumeCandidateSettlements(
  tx: RowAutomationExecutor,
  candidateIds: readonly string[],
  consumedById: string,
  now: Date
): Promise<void> {
  if (candidateIds.length === 0) return;
  await tx
    .update(rowSettlements)
    .set({
      consumedById,
      finishedAt: now,
      status: 'skipped',
      updatedAt: now,
    })
    .where(inArray(rowSettlements.id, candidateIds));
}

export async function setRowSettlementWorkerFailure(
  db: Database,
  rawInput: RowSettlementInput & { errorMessage: string; retrying: boolean }
): Promise<void> {
  const input = rowSettlementInputSchema.parse({
    rowId: rawInput.rowId,
    rowVersion: rawInput.rowVersion,
    settlementId: rawInput.settlementId,
    tableId: rawInput.tableId,
    workspaceId: rawInput.workspaceId,
  });
  await db
    .update(rowSettlements)
    .set({
      errorMessage: safeErrorMessage(rawInput.errorMessage),
      finishedAt: rawInput.retrying ? null : new Date(),
      status: rawInput.retrying ? 'queued' : 'failed',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(rowSettlements.id, input.settlementId),
        eq(rowSettlements.workspaceId, input.workspaceId),
        inArray(rowSettlements.status, ['queued', 'running'])
      )
    );
}

function readConnectorRunMode(
  configuration: Readonly<Record<string, unknown>>
): ConnectorRunMode | null {
  const parsers = [
    connectorActionColumnConfigurationSchema,
    httpEnrichmentColumnConfigurationSchema,
    httpWaterfallColumnConfigurationSchema,
  ];
  for (const parser of parsers) {
    const parsed = parser.safeParse(configuration);
    if (parsed.success) return parsed.data.runMode;
  }
  return null;
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}
