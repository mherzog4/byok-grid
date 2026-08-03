import {
  connectorActionColumnConfigurationSchema,
  decideAutomaticFanout,
  rowSettlementInputSchema,
  type RowSettlementInput,
} from '@byok-grid/domain';
import { and, eq, inArray, isNull, lte } from 'drizzle-orm';
import {
  type SqliteDatabase,
  type SqliteTransaction,
  withSqliteWriteTransaction,
} from './client';
import { queueAutomaticSqliteEnrichmentCellRunInTransaction } from './enrichments';
import {
  cells,
  columnDependencies,
  columns,
  rows,
  rowSettlements,
} from './schema';
import { queueSettledSqliteWebhookDeliveries } from './webhooks';
import { queueSettledSqliteWritebackDeliveries } from './writebacks';

export interface SqliteRowSettlementOptions {
  maximumAutomaticRuns?: number;
  maximumAutomaticWritebacks?: number;
}

export type SqliteRowSettlementResult = {
  queuedDeliveryCount: number;
  queuedRunCount: number;
  status: 'failed' | 'skipped' | 'succeeded';
};

export async function processSqliteRowSettlement(
  db: SqliteDatabase,
  rawInput: RowSettlementInput,
  options: SqliteRowSettlementOptions = {}
): Promise<SqliteRowSettlementResult> {
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

  return withSqliteWriteTransaction(db, async (tx) => {
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
      .limit(1);
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
      .limit(1);
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
      await markSettlementSkipped(tx, settlement.id, now);
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
      );
    const deliveryChangedColumnIds = [
      ...new Set(
        candidates.flatMap(({ changedColumnIds }) => changedColumnIds)
      ),
    ].sort();
    const changedColumnIds = [
      ...new Set(
        candidates
          .filter(({ queuedRunCount }) => queuedRunCount === 0)
          .flatMap(({ changedColumnIds }) => changedColumnIds)
      ),
    ].sort();

    const dependentColumns =
      changedColumnIds.length === 0
        ? []
        : await tx
            .select({ configuration: columns.configuration, id: columns.id })
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
        dependentColumns.flatMap((column) => {
          const parsed = connectorActionColumnConfigurationSchema.safeParse(
            column.configuration
          );
          return parsed.success && parsed.data.runMode === 'on_change'
            ? [column.id]
            : [];
        })
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
    if (
      existingTargetCells.some(
        ({ status }) => status === 'queued' || status === 'running'
      )
    ) {
      await markSettlementSkipped(tx, settlement.id, now);
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
    const candidateIds = candidates.map(({ id }) => id);
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
      await queueAutomaticSqliteEnrichmentCellRunInTransaction(tx, {
        columnId,
        rowId: input.rowId,
        tableId: input.tableId,
        workspaceId: input.workspaceId,
      });
    }
    if (decision.columnIds.length > 0) {
      await consumeCandidateSettlements(
        tx,
        candidateIds.filter((id) => id !== settlement.id),
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
      await markSettlementSkipped(tx, settlement.id, now);
      return {
        queuedDeliveryCount: 0,
        queuedRunCount: 0,
        status: 'skipped' as const,
      };
    }

    const writebackResult = await queueSettledSqliteWritebackDeliveries(tx, {
      changedColumnIds: deliveryChangedColumnIds,
      maximumAutomaticWritebacks,
      rowId: input.rowId,
      rowVersion: input.rowVersion,
      tableId: input.tableId,
      workspaceId: input.workspaceId,
    });
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
    const queuedWebhookCount = await queueSettledSqliteWebhookDeliveries(
      tx,
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

export async function setSqliteRowSettlementWorkerFailure(
  db: SqliteDatabase,
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

async function consumeCandidateSettlements(
  tx: SqliteTransaction,
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
    .where(inArray(rowSettlements.id, [...candidateIds]));
}

async function markSettlementSkipped(
  tx: SqliteTransaction,
  settlementId: string,
  now: Date
): Promise<void> {
  await tx
    .update(rowSettlements)
    .set({ finishedAt: now, status: 'skipped', updatedAt: now })
    .where(eq(rowSettlements.id, settlementId));
}

function safeErrorMessage(message: string): string {
  return message.replace(/[\r\n\t]/g, ' ').slice(0, 500);
}
