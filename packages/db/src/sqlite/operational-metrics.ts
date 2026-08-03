import type { Client, ResultSet } from '@libsql/client';
import { DISPATCHABLE_OUTBOX_EVENT_TYPES } from './outbox';

export const OPERATIONAL_METRICS_WINDOW_SECONDS = 300;

const workflowRunStatuses = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
const terminalWorkflowRunStatuses = [
  'succeeded',
  'failed',
  'cancelled',
] as const;
const activeWorkflowStepStatuses = ['ready', 'running'] as const;

type WorkflowRunStatus = (typeof workflowRunStatuses)[number];
type TerminalWorkflowRunStatus = (typeof terminalWorkflowRunStatuses)[number];
type ActiveWorkflowStepStatus = (typeof activeWorkflowStepStatuses)[number];

export interface SqliteOperationalMetricsSnapshot {
  activeWorkflowStepOldestAgeSeconds: Record<ActiveWorkflowStepStatus, number>;
  activeWorkflowSteps: Record<ActiveWorkflowStepStatus, number>;
  observedAtEpochSeconds: number;
  oldestQueuedWorkflowAgeSeconds: number;
  oldestUnpublishedOutboxAgeSeconds: number;
  recentTerminalWorkflowRuns: Record<TerminalWorkflowRunStatus, number>;
  terminalWindowSeconds: number;
  unpublishedOutboxEvents: number;
  workflowRuns: Record<WorkflowRunStatus, number>;
}

/**
 * Collects bounded, deployment-wide state for low-cardinality operational
 * alerts. No tenant identifier, payload, provider error, or user data leaves
 * SQLite through this snapshot.
 */
export async function collectSqliteOperationalMetrics(
  client: Client,
  now = new Date()
): Promise<SqliteOperationalMetricsSnapshot> {
  const nowMilliseconds = now.getTime();
  const terminalWindowStart =
    nowMilliseconds - OPERATIONAL_METRICS_WINDOW_SECONDS * 1_000;
  const dispatchablePlaceholders = DISPATCHABLE_OUTBOX_EVENT_TYPES.map(
    () => '?'
  ).join(', ');
  const results = await client.batch(
    [
      `select status, count(*), min(created_at)
           from workflow_runs
          group by status`,
      {
        args: [terminalWindowStart],
        sql: `select status, count(*)
                  from workflow_runs
                 where status in ('succeeded', 'failed', 'cancelled')
                   and updated_at >= ?
                 group by status`,
      },
      {
        args: [...DISPATCHABLE_OUTBOX_EVENT_TYPES],
        sql: `select count(*), min(created_at)
                  from outbox_events
                 where published_at is null
                   and event_type in (${dispatchablePlaceholders})`,
      },
      `select status, count(*), min(updated_at)
           from workflow_step_runs
          where status in ('ready', 'running')
          group by status`,
    ],
    'read'
  );
  if (results.length !== 4) {
    throw new Error('Expected four operational metrics query results.');
  }
  const [workflowRunsResult, recentTerminalResult, outboxResult, stepsResult] =
    results as [ResultSet, ResultSet, ResultSet, ResultSet];

  const workflowRuns = zeroRecord(workflowRunStatuses);
  let oldestQueuedWorkflowAgeSeconds = 0;
  for (const row of workflowRunsResult.rows) {
    const status = parseMember(row[0], workflowRunStatuses, 'workflow status');
    workflowRuns[status] = parseCount(row[1], `workflow ${status} count`);
    if (status === 'queued') {
      oldestQueuedWorkflowAgeSeconds = ageSeconds(
        nowMilliseconds,
        row[2],
        'oldest queued workflow timestamp'
      );
    }
  }

  const recentTerminalWorkflowRuns = zeroRecord(terminalWorkflowRunStatuses);
  for (const row of recentTerminalResult.rows) {
    const status = parseMember(
      row[0],
      terminalWorkflowRunStatuses,
      'terminal workflow status'
    );
    recentTerminalWorkflowRuns[status] = parseCount(
      row[1],
      `recent ${status} workflow count`
    );
  }

  const outboxRow = requireSingleRow(outboxResult, 'outbox metrics');
  const unpublishedOutboxEvents = parseCount(
    outboxRow[0],
    'unpublished outbox count'
  );
  const oldestUnpublishedOutboxAgeSeconds = ageSeconds(
    nowMilliseconds,
    outboxRow[1],
    'oldest unpublished outbox timestamp'
  );

  const activeWorkflowSteps = zeroRecord(activeWorkflowStepStatuses);
  const activeWorkflowStepOldestAgeSeconds = zeroRecord(
    activeWorkflowStepStatuses
  );
  for (const row of stepsResult.rows) {
    const status = parseMember(
      row[0],
      activeWorkflowStepStatuses,
      'workflow step status'
    );
    activeWorkflowSteps[status] = parseCount(
      row[1],
      `${status} workflow step count`
    );
    activeWorkflowStepOldestAgeSeconds[status] = ageSeconds(
      nowMilliseconds,
      row[2],
      `oldest ${status} workflow step timestamp`
    );
  }

  return {
    activeWorkflowStepOldestAgeSeconds,
    activeWorkflowSteps,
    observedAtEpochSeconds: nowMilliseconds / 1_000,
    oldestQueuedWorkflowAgeSeconds,
    oldestUnpublishedOutboxAgeSeconds,
    recentTerminalWorkflowRuns,
    terminalWindowSeconds: OPERATIONAL_METRICS_WINDOW_SECONDS,
    unpublishedOutboxEvents,
    workflowRuns,
  };
}

function zeroRecord<const Values extends readonly string[]>(
  values: Values
): Record<Values[number], number> {
  return Object.fromEntries(values.map((value) => [value, 0])) as Record<
    Values[number],
    number
  >;
}

function parseMember<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string
): Values[number] {
  const normalized = String(value);
  if (!values.includes(normalized)) {
    throw new Error(`Unexpected ${label} in operational metrics.`);
  }
  return normalized as Values[number];
}

function parseCount(value: unknown, label: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid ${label} in operational metrics.`);
  }
  return count;
}

function ageSeconds(
  nowMilliseconds: number,
  value: unknown,
  label: string
): number {
  if (value === null || value === undefined) return 0;
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`Invalid ${label} in operational metrics.`);
  }
  return Math.max(0, (nowMilliseconds - timestamp) / 1_000);
}

function requireSingleRow(result: ResultSet, label: string) {
  const row = result.rows[0];
  if (!row || result.rows.length !== 1) {
    throw new Error(`Expected one ${label} row.`);
  }
  return row;
}
