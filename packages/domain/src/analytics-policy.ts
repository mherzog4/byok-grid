import { z } from 'zod';

export const ANALYTICS_EVENT_TYPES = [
  'cell.run_failed',
  'cell.run_succeeded',
  'table.csv_import_succeeded',
  'table.ingestion_batch_succeeded',
  'table.source_run_succeeded',
] as const;

export type AnalyticsEventType = (typeof ANALYTICS_EVENT_TYPES)[number];

const uuid = z.string().uuid();
const nonnegativeCount = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const errorCode = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9_.-]+$/);

const payloadByType = {
  'cell.run_failed': z.strictObject({
    cellId: uuid,
    errorCode,
    runId: uuid,
  }),
  'cell.run_succeeded': z.strictObject({ cellId: uuid, runId: uuid }),
  'table.csv_import_succeeded': z.strictObject({
    importJobId: uuid,
    importedRowCount: nonnegativeCount,
    tableId: uuid,
  }),
  'table.ingestion_batch_succeeded': z.strictObject({
    batchId: uuid,
    createdRowCount: nonnegativeCount,
    endpointId: uuid,
    recordCount: nonnegativeCount,
    tableId: uuid,
    updatedRowCount: nonnegativeCount,
  }),
  'table.source_run_succeeded': z.strictObject({
    archivedRowCount: nonnegativeCount,
    createdRowCount: nonnegativeCount,
    pageCount: nonnegativeCount,
    receivedRecordCount: nonnegativeCount,
    restoredRowCount: nonnegativeCount,
    sourceId: uuid,
    sourceRunId: uuid,
    tableId: uuid,
    updatedRowCount: nonnegativeCount,
  }),
} satisfies Record<AnalyticsEventType, z.ZodType>;

export interface AnalyticsSourceEvent {
  aggregateId: string;
  aggregateType: string;
  createdAt: Date;
  eventType: AnalyticsEventType;
  id: string;
  payload: Readonly<Record<string, unknown>>;
  workspaceId: string;
}

export interface AnalyticsProjectionRow {
  aggregate_id: string;
  aggregate_type: string;
  archived_row_count: number;
  created_row_count: number;
  dimension_id: string | null;
  error_code: string;
  event_id: string;
  event_type: AnalyticsEventType;
  occurred_at: string;
  outcome: 'failed' | 'succeeded';
  page_count: number;
  projected_at: string;
  record_count: number;
  restored_row_count: number;
  table_id: string | null;
  updated_row_count: number;
  workspace_id: string;
}

export class AnalyticsEventValidationError extends Error {}

export function toAnalyticsProjectionRow(
  event: AnalyticsSourceEvent,
  projectedAt: Date
): AnalyticsProjectionRow {
  if (
    !uuid.safeParse(event.id).success ||
    !uuid.safeParse(event.workspaceId).success
  ) {
    throw new AnalyticsEventValidationError(
      'An analytics event has an invalid event or workspace identifier.'
    );
  }
  if (
    !uuid.safeParse(event.aggregateId).success ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(event.aggregateType) ||
    Number.isNaN(event.createdAt.getTime()) ||
    Number.isNaN(projectedAt.getTime())
  ) {
    throw new AnalyticsEventValidationError(
      'An analytics event has invalid aggregate metadata.'
    );
  }
  const schema = payloadByType[event.eventType];
  const payload = schema.safeParse(event.payload);
  if (!payload.success) {
    throw new AnalyticsEventValidationError(
      `The ${event.eventType} analytics payload does not match its public contract.`
    );
  }

  const common = {
    aggregate_id: event.aggregateId,
    aggregate_type: event.aggregateType,
    archived_row_count: 0,
    created_row_count: 0,
    error_code: '',
    event_id: event.id,
    event_type: event.eventType,
    occurred_at: toClickHouseTimestamp(event.createdAt),
    outcome: (event.eventType === 'cell.run_failed'
      ? 'failed'
      : 'succeeded') as AnalyticsProjectionRow['outcome'],
    page_count: 0,
    projected_at: toClickHouseTimestamp(projectedAt),
    record_count: 0,
    restored_row_count: 0,
    table_id: null,
    updated_row_count: 0,
    workspace_id: event.workspaceId,
  };

  if (event.eventType === 'cell.run_failed') {
    const value = payloadByType[event.eventType].parse(event.payload);
    return {
      ...common,
      dimension_id: value.runId,
      error_code: value.errorCode,
    };
  }
  if (event.eventType === 'cell.run_succeeded') {
    const value = payloadByType[event.eventType].parse(event.payload);
    return { ...common, dimension_id: value.runId };
  }
  if (event.eventType === 'table.csv_import_succeeded') {
    const value = payloadByType[event.eventType].parse(event.payload);
    return {
      ...common,
      dimension_id: value.importJobId,
      record_count: value.importedRowCount,
      table_id: value.tableId,
    };
  }
  if (event.eventType === 'table.ingestion_batch_succeeded') {
    const value = payloadByType[event.eventType].parse(event.payload);
    return {
      ...common,
      created_row_count: value.createdRowCount,
      dimension_id: value.endpointId,
      record_count: value.recordCount,
      table_id: value.tableId,
      updated_row_count: value.updatedRowCount,
    };
  }
  const value = payloadByType[event.eventType].parse(event.payload);
  return {
    ...common,
    archived_row_count: value.archivedRowCount,
    created_row_count: value.createdRowCount,
    dimension_id: value.sourceId,
    page_count: value.pageCount,
    record_count: value.receivedRecordCount,
    restored_row_count: value.restoredRowCount,
    table_id: value.tableId,
    updated_row_count: value.updatedRowCount,
  };
}

function toClickHouseTimestamp(value: Date): string {
  return value.toISOString().replace('T', ' ').replace('Z', '');
}
