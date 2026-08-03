import { describe, expect, it } from 'vitest';
import {
  AnalyticsEventValidationError,
  toAnalyticsProjectionRow,
} from './analytics-policy';

const eventId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const aggregateId = '33333333-3333-4333-8333-333333333333';
const tableId = '44444444-4444-4444-8444-444444444444';

describe('analytics projection policy', () => {
  it('maps allowlisted terminal metrics without forwarding arbitrary payloads', () => {
    expect(
      toAnalyticsProjectionRow(
        {
          aggregateId,
          aggregateType: 'ingestion_batch',
          createdAt: new Date('2026-08-01T12:34:56.789Z'),
          eventType: 'table.ingestion_batch_succeeded',
          id: eventId,
          payload: {
            batchId: aggregateId,
            createdRowCount: 7,
            endpointId: '55555555-5555-4555-8555-555555555555',
            recordCount: 10,
            tableId,
            updatedRowCount: 3,
          },
          workspaceId,
        },
        new Date('2026-08-01T12:35:00.001Z')
      )
    ).toMatchObject({
      created_row_count: 7,
      occurred_at: '2026-08-01 12:34:56.789',
      outcome: 'succeeded',
      projected_at: '2026-08-01 12:35:00.001',
      record_count: 10,
      table_id: tableId,
      updated_row_count: 3,
    });
  });

  it('fails closed when a future producer adds an unreviewed payload field', () => {
    expect(() =>
      toAnalyticsProjectionRow(
        {
          aggregateId,
          aggregateType: 'cell',
          createdAt: new Date(),
          eventType: 'cell.run_succeeded',
          id: eventId,
          payload: {
            cellId: aggregateId,
            secret: 'must-not-project',
            runId: tableId,
          },
          workspaceId,
        },
        new Date()
      )
    ).toThrow(AnalyticsEventValidationError);
  });

  it('projects source reconciliation counts without source records', () => {
    expect(
      toAnalyticsProjectionRow(
        {
          aggregateId,
          aggregateType: 'source_run',
          createdAt: new Date('2026-08-01T12:34:56.789Z'),
          eventType: 'table.source_run_succeeded',
          id: eventId,
          payload: {
            archivedRowCount: 4,
            createdRowCount: 2,
            pageCount: 3,
            receivedRecordCount: 9,
            restoredRowCount: 1,
            sourceId: aggregateId,
            sourceRunId: tableId,
            tableId,
            updatedRowCount: 7,
          },
          workspaceId,
        },
        new Date('2026-08-01T12:35:00.001Z')
      )
    ).toMatchObject({
      archived_row_count: 4,
      created_row_count: 2,
      record_count: 9,
      restored_row_count: 1,
      updated_row_count: 7,
    });
  });
});
