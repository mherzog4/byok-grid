import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  runAnalyticsProjectorLifecycle,
  type AnalyticsProjectorSignalSource,
} from './lifecycle';

describe('analytics projector lifecycle', () => {
  it.runIf(process.platform !== 'win32')(
    'withdraws readiness and exits cleanly on operating-system SIGTERM',
    async () => {
      const lifecycleUrl = new URL('./lifecycle.ts', import.meta.url).href;
      const childScript = `
        import { runAnalyticsProjectorLifecycle } from ${JSON.stringify(lifecycleUrl)};
        const keepAlive = setInterval(() => undefined, 1_000);
        await runAnalyticsProjectorLifecycle({
          closeDatabase: () => {
            clearInterval(keepAlive);
            console.log('DATABASE_CLOSED');
          },
          ensureSchema: async () => undefined,
          eraseBatch: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => {
            console.log('PROJECTION_ABORTED');
            resolve(0);
          }, { once: true })),
          health: {
            close: async () => console.log('HEALTH_CLOSED'),
            listen: async () => console.log('LISTENING'),
            setReady: (ready) => console.log(ready ? 'READY' : 'NOT_READY'),
          },
          pollMilliseconds: 1_000,
          projectBatch: async () => 0,
          reportFailure: () => console.log('FAILURE_UNEXPECTED'),
          signalSource: process,
        });
      `;
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', childScript],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let standardOutput = '';
      let standardError = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        standardOutput += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        standardError += chunk;
      });

      try {
        await waitFor(() => standardOutput.includes('READY\n'));
        const exitPromise = waitForChildExit(child);
        expect(child.kill('SIGTERM')).toBe(true);
        await expect(exitPromise).resolves.toEqual({ code: 0, signal: null });
        expect(standardOutput.trim().split('\n'), standardError).toEqual([
          'LISTENING',
          'READY',
          'NOT_READY',
          'PROJECTION_ABORTED',
          'NOT_READY',
          'HEALTH_CLOSED',
          'DATABASE_CLOSED',
        ]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    }
  );

  it('retries initialization, becomes ready, and withdraws before cleanup', async () => {
    const signals = new EventEmitter() as AnalyticsProjectorSignalSource &
      EventEmitter;
    const projectionStarted = deferred();
    const events: string[] = [];
    let initializationAttempts = 0;

    const lifecycle = runAnalyticsProjectorLifecycle({
      closeDatabase: () => events.push('database.close'),
      ensureSchema: async () => {
        initializationAttempts += 1;
        events.push(`initialize.${initializationAttempts}`);
        if (initializationAttempts === 1) throw new Error('clickhouse outage');
      },
      eraseBatch: (signal) => {
        events.push('projection.start');
        projectionStarted.resolve();
        return new Promise<number>((resolve) => {
          signal.addEventListener('abort', () => resolve(0), { once: true });
        });
      },
      health: {
        close: async () => {
          events.push('health.close');
        },
        listen: async () => {
          events.push('health.listen');
        },
        setReady: (ready) => events.push(`ready.${ready}`),
      },
      pollMilliseconds: 1_000,
      projectBatch: async () => {
        events.push('project.unexpected');
        return 0;
      },
      reportFailure: (phase) => events.push(`failure.${phase}`),
      signalSource: signals,
      wait: async () => {
        events.push('retry.wait');
      },
    });

    await projectionStarted.promise;
    signals.emit('SIGTERM');
    await lifecycle;

    expect(events).toContain('failure.initialization');
    expect(events).toContain('ready.true');
    expect(events).not.toContain('project.unexpected');
    expect(events.indexOf('ready.false')).toBeLessThan(
      events.indexOf('health.close')
    );
    expect(events.indexOf('health.close')).toBeLessThan(
      events.indexOf('database.close')
    );
    expect(initializationAttempts).toBe(2);
  });

  it('aborts initialization cleanly without ever becoming ready', async () => {
    const signals = new EventEmitter() as AnalyticsProjectorSignalSource &
      EventEmitter;
    const initializationStarted = deferred();
    const events: string[] = [];
    let receivedSignal: AbortSignal | undefined;

    const lifecycle = runAnalyticsProjectorLifecycle({
      closeDatabase: () => events.push('database.close'),
      ensureSchema: (signal) => {
        receivedSignal = signal;
        initializationStarted.resolve();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('request aborted')),
            { once: true }
          );
        });
      },
      eraseBatch: async () => 0,
      health: {
        close: async () => {
          events.push('health.close');
        },
        listen: async () => undefined,
        setReady: (ready) => events.push(`ready.${ready}`),
      },
      pollMilliseconds: 1_000,
      projectBatch: async () => 0,
      reportFailure: () => events.push('failure.unexpected'),
      signalSource: signals,
    });

    await initializationStarted.promise;
    signals.emit('SIGINT');
    await lifecycle;

    expect(receivedSignal?.aborted).toBe(true);
    expect(events).not.toContain('ready.true');
    expect(events).not.toContain('failure.unexpected');
    expect(events.at(-2)).toBe('health.close');
    expect(events.at(-1)).toBe('database.close');
  });

  it('propagates health-listener failure after closing resources', async () => {
    const signals = new EventEmitter() as AnalyticsProjectorSignalSource &
      EventEmitter;
    const events: string[] = [];

    await expect(
      runAnalyticsProjectorLifecycle({
        closeDatabase: () => events.push('database.close'),
        ensureSchema: async () => undefined,
        eraseBatch: async () => 0,
        health: {
          close: async () => {
            events.push('health.close');
          },
          listen: async () => {
            throw new Error('health port unavailable');
          },
          setReady: (ready) => events.push(`ready.${ready}`),
        },
        pollMilliseconds: 1_000,
        projectBatch: async () => 0,
        reportFailure: () => undefined,
        signalSource: signals,
      })
    ).rejects.toThrow('health port unavailable');
    expect(events.at(-2)).toBe('health.close');
    expect(events.at(-1)).toBe('database.close');
  });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMilliseconds = 5_000
): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for child.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function waitForChildExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}
