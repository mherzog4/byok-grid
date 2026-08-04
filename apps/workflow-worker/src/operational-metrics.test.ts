import { describe, expect, it } from 'vitest';
import {
  createOperationalMetrics,
  createOperationalMetricsTask,
} from './operational-metrics';

describe('workflow operational metrics server', () => {
  it('coalesces overlapping metrics collections', async () => {
    const collectionStarted = deferred<void>();
    const finishCollection = deferred<void>();
    let collectionCount = 0;
    const metrics = createOperationalMetrics(
      async () => {
        collectionCount += 1;
        collectionStarted.resolve();
        await finishCollection.promise;
        return snapshot();
      },
      () => ({ acquisitionExhaustions: 1, acquisitionRetries: 3 })
    );

    const first = metrics.scrape();
    await collectionStarted.promise;
    const second = metrics.scrape();
    expect(collectionCount).toBe(1);
    finishCollection.resolve();

    const [firstBody, secondBody] = await Promise.all([first, second]);
    expect(secondBody).toBe(firstBody);
    expect(collectionCount).toBe(1);
  });

  it('exposes bounded series and stops on abort', async () => {
    const controller = new AbortController();
    const listening = deferred<number>();
    const task = createOperationalMetricsTask({
      collect: async () => snapshot(),
      collectContention: () => ({
        acquisitionExhaustions: 1,
        acquisitionRetries: 3,
      }),
      host: '127.0.0.1',
      onListening: ({ port }) => listening.resolve(port),
      port: 0,
    });
    const running = task.run(controller.signal);

    try {
      const port = await listening.promise;
      const first = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(first.status).toBe(200);
      expect(first.headers.get('cache-control')).toBe('no-store');
      expect(first.headers.get('content-type')).toContain(
        'text/plain; version=0.0.4'
      );
      const body = await first.text();
      expect(body).toContain('byok_grid_workflow_runs{status="queued"} 2');
      expect(body).toContain(
        'byok_grid_workflow_terminal_runs{status="failed",window_seconds="300"} 1'
      );
      expect(body).toContain(
        'byok_grid_outbox_unpublished_oldest_age_seconds 13'
      );
      expect(body).toContain(
        'byok_grid_sqlite_write_acquisition_events{outcome="retry"} 3'
      );
      expect(body).toContain(
        'byok_grid_sqlite_write_acquisition_events{outcome="exhausted"} 1'
      );
      expect(body).not.toContain('workspace-');

      const missing = await fetch(`http://127.0.0.1:${port}/health`);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe('Not Found');
    } finally {
      controller.abort();
      await running;
    }
  });

  it('fails closed without returning database error details', async () => {
    const controller = new AbortController();
    const listening = deferred<number>();
    const task = createOperationalMetricsTask({
      collect: async () => {
        throw new Error('libsql://secret-host.example/private-token');
      },
      host: '127.0.0.1',
      onListening: ({ port }) => listening.resolve(port),
      port: 0,
    });
    const running = task.run(controller.signal);

    try {
      const port = await listening.promise;
      const response = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toBe('Metrics unavailable');
      expect(body).not.toContain('secret-host');
      expect(body).not.toContain('private-token');
    } finally {
      controller.abort();
      await running;
    }
  });
});

function snapshot() {
  return {
    activeWorkflowStepOldestAgeSeconds: { ready: 7, running: 9 },
    activeWorkflowSteps: { ready: 3, running: 1 },
    observedAtEpochSeconds: 1_893_499_200,
    oldestQueuedWorkflowAgeSeconds: 11,
    oldestUnpublishedOutboxAgeSeconds: 13,
    recentTerminalWorkflowRuns: {
      cancelled: 0,
      failed: 1,
      succeeded: 4,
    },
    terminalWindowSeconds: 300,
    unpublishedOutboxEvents: 2,
    workflowRuns: {
      cancelled: 0,
      failed: 1,
      queued: 2,
      running: 1,
      succeeded: 8,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
