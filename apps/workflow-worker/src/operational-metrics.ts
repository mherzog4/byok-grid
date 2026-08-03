import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SqliteOperationalMetricsSnapshot } from '@byok-grid/db';
import { Gauge, Registry } from 'prom-client';
import type { WorkerLifecycleTask } from './worker-lifecycle';

const SCRAPE_TIMEOUT_MILLISECONDS = 5_000;
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

export interface OperationalMetricsTaskOptions {
  collect: () => Promise<SqliteOperationalMetricsSnapshot>;
  host?: string;
  onListening?: (address: AddressInfo) => void;
  port: number;
}

export function createOperationalMetricsTask(
  options: OperationalMetricsTaskOptions
): WorkerLifecycleTask {
  const metrics = createOperationalMetrics(options.collect);
  return {
    name: 'operational metrics server',
    run: (signal) => runMetricsServer({ ...options, metrics, signal }),
  };
}

function createOperationalMetrics(
  collect: () => Promise<SqliteOperationalMetricsSnapshot>
) {
  const registry = new Registry();
  const workflowRuns = gauge(registry, {
    help: 'Current workflow run count by lifecycle status.',
    labelNames: ['status'],
    name: 'byok_grid_workflow_runs',
  });
  const oldestQueuedWorkflowAge = gauge(registry, {
    help: 'Age in seconds of the oldest queued workflow, or zero when empty.',
    name: 'byok_grid_workflow_queue_oldest_age_seconds',
  });
  const recentTerminalWorkflowRuns = gauge(registry, {
    help: 'Terminal workflow runs observed in the bounded metrics window.',
    labelNames: ['status', 'window_seconds'],
    name: 'byok_grid_workflow_terminal_runs',
  });
  const activeWorkflowSteps = gauge(registry, {
    help: 'Current workflow step count for dispatchable or leased states.',
    labelNames: ['status'],
    name: 'byok_grid_workflow_active_steps',
  });
  const activeWorkflowStepOldestAge = gauge(registry, {
    help: 'Age in seconds of the oldest workflow step in an active state.',
    labelNames: ['status'],
    name: 'byok_grid_workflow_active_step_oldest_age_seconds',
  });
  const unpublishedOutboxEvents = gauge(registry, {
    help: 'Current count of unpublished dispatch outbox events.',
    name: 'byok_grid_outbox_unpublished_events',
  });
  const oldestUnpublishedOutboxAge = gauge(registry, {
    help: 'Age in seconds of the oldest unpublished outbox event, or zero when empty.',
    name: 'byok_grid_outbox_unpublished_oldest_age_seconds',
  });
  const collectionTimestamp = gauge(registry, {
    help: 'Unix timestamp of the most recent successful BYOK Grid metrics collection.',
    name: 'byok_grid_metrics_collection_timestamp_seconds',
  });

  let scrapeInFlight: Promise<string> | undefined;
  return {
    contentType: registry.contentType,
    scrape(): Promise<string> {
      scrapeInFlight ??= collect()
        .then(async (snapshot) => {
          for (const status of workflowRunStatuses) {
            workflowRuns.labels(status).set(snapshot.workflowRuns[status]);
          }
          oldestQueuedWorkflowAge.set(snapshot.oldestQueuedWorkflowAgeSeconds);
          for (const status of terminalWorkflowRunStatuses) {
            recentTerminalWorkflowRuns
              .labels(status, String(snapshot.terminalWindowSeconds))
              .set(snapshot.recentTerminalWorkflowRuns[status]);
          }
          for (const status of activeWorkflowStepStatuses) {
            activeWorkflowSteps
              .labels(status)
              .set(snapshot.activeWorkflowSteps[status]);
            activeWorkflowStepOldestAge
              .labels(status)
              .set(snapshot.activeWorkflowStepOldestAgeSeconds[status]);
          }
          unpublishedOutboxEvents.set(snapshot.unpublishedOutboxEvents);
          oldestUnpublishedOutboxAge.set(
            snapshot.oldestUnpublishedOutboxAgeSeconds
          );
          collectionTimestamp.set(snapshot.observedAtEpochSeconds);
          return registry.metrics();
        })
        .finally(() => {
          scrapeInFlight = undefined;
        });
      return scrapeInFlight;
    },
  };
}

function gauge(
  registry: Registry,
  configuration: {
    help: string;
    labelNames?: string[];
    name: string;
  }
) {
  return new Gauge({
    ...configuration,
    labelNames: configuration.labelNames ?? [],
    registers: [registry],
  });
}

async function runMetricsServer(input: {
  host?: string;
  metrics: ReturnType<typeof createOperationalMetrics>;
  onListening?: (address: AddressInfo) => void;
  port: number;
  signal: AbortSignal;
}): Promise<void> {
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET' || request.url !== '/metrics') {
      writeText(response, 404, 'Not Found');
      return;
    }

    try {
      const body = await withTimeout(
        input.metrics.scrape(),
        SCRAPE_TIMEOUT_MILLISECONDS
      );
      response.writeHead(200, { 'Content-Type': input.metrics.contentType });
      response.end(body);
    } catch {
      writeText(response, 503, 'Metrics unavailable');
    }
  });
  configureServerLimits(server);

  await listen(server, input.port, input.host ?? '0.0.0.0');
  const address = server.address();
  if (!address || typeof address === 'string') {
    await closeServer(server);
    throw new Error('Operational metrics server has no TCP address.');
  }
  input.onListening?.(address);

  if (!input.signal.aborted) {
    await new Promise<void>((resolve, reject) => {
      const stop = () => resolve();
      const fail = (error: Error) => reject(error);
      input.signal.addEventListener('abort', stop, { once: true });
      server.once('error', fail);
    });
  }
  await closeServer(server);
}

function configureServerLimits(server: Server): void {
  server.headersTimeout = SCRAPE_TIMEOUT_MILLISECONDS;
  server.keepAliveTimeout = SCRAPE_TIMEOUT_MILLISECONDS;
  server.requestTimeout = SCRAPE_TIMEOUT_MILLISECONDS;
  server.maxRequestsPerSocket = 100;
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = (error: Error) => reject(error);
    server.once('error', fail);
    server.listen(port, host, () => {
      server.removeListener('error', fail);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeIdleConnections();
  });
}

function writeText(response: ServerResponse, status: number, body: string) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(body);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Operational metrics collection timed out.')),
      milliseconds
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
