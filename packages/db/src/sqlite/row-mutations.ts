import {
  connectorActionColumnConfigurationSchema,
  gridViewFilterLeaves,
  MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE,
  normalizeGridViewFilterTree,
  rowSettlementInputSchema,
} from '@byok-grid/domain';
import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { SqliteTransaction } from './client';
import {
  columnDependencies,
  columns,
  outboxEvents,
  rows,
  rowSettlements,
  webhookDestinations,
  writebackDestinations,
} from './schema';

export interface SqliteRowMutationScope {
  changedColumnIds: readonly string[];
  rowId: string;
  tableId: string;
  workspaceId: string;
}

export async function recordSqliteRowMutationAndMaybeQueueSettlement(
  tx: SqliteTransaction,
  input: SqliteRowMutationScope
): Promise<{ rowVersion: number; settlementId: string | null }> {
  const now = new Date();
  const [row] = await tx
    .update(rows)
    .set({ updatedAt: now, version: sql`${rows.version} + 1` })
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
  const automaticWebhooks = await tx
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
    .limit(1);
  const automaticWritebacks = await tx
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
    .limit(MAXIMUM_WRITEBACK_DESTINATIONS_PER_TABLE);
  const dependentConnectors =
    changedColumnIds.length === 0
      ? []
      : await tx
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
          );
  const pendingDeliverySettlements = await tx
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
    .limit(1);

  const hasAutomaticDependent = dependentConnectors.some(
    ({ configuration }) => {
      const parsed =
        connectorActionColumnConfigurationSchema.safeParse(configuration);
      return parsed.success && parsed.data.runMode === 'on_change';
    }
  );
  const changedColumnIdSet = new Set(changedColumnIds);
  const hasRelevantAutomaticWriteback = automaticWritebacks.some(
    (destination) =>
      [
        destination.recordIdColumnId,
        ...destination.fieldMappings.map(({ columnId }) => columnId),
        ...gridViewFilterLeaves(
          normalizeGridViewFilterTree(destination.filterTree)
        ).map(({ columnId }) => columnId),
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
  const [settlement] = await tx
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
  await tx.insert(outboxEvents).values({
    aggregateId: settlement.id,
    aggregateType: 'row_settlement',
    eventType: 'table.row_settled',
    payload: workerInput,
    workspaceId: input.workspaceId,
  });
  return { rowVersion: row.version, settlementId: settlement.id };
}
