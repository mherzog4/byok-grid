import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  runWorkerLifecycle,
  type WorkerLifecycleSignalSource,
} from './worker-lifecycle';

describe('workflow worker lifecycle', () => {
  it.runIf(process.platform !== 'win32')(
    'drains before exit when the operating system sends SIGTERM',
    async () => {
      const lifecycleUrl = new URL('./worker-lifecycle.ts', import.meta.url)
        .href;
      const childScript = `
        import { runWorkerLifecycle } from ${JSON.stringify(lifecycleUrl)};
        let finishWorker;
        const workerRun = new Promise((resolve) => { finishWorker = resolve; });
        const keepAlive = setInterval(() => undefined, 1_000);
        await runWorkerLifecycle({
          backgroundTasks: [{
            name: 'poller',
            run: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => {
              console.log('POLLER_ABORTED');
              resolve();
            }, { once: true })),
          }],
          closeDatabase: () => console.log('DATABASE_CLOSED'),
          signalSource: process,
          worker: {
            start: async () => {
              console.log('READY');
              await workerRun;
            },
            stop: async () => {
              console.log('STOP_REQUESTED');
              await new Promise((resolve) => setTimeout(resolve, 25));
              console.log('WORKER_DRAINED');
              clearInterval(keepAlive);
              finishWorker();
            },
          },
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
        const exit = await exitPromise;
        expect(
          exit,
          `${standardError}\nChild standard output:\n${standardOutput}`
        ).toEqual({ code: 0, signal: null });
        expect(standardOutput.trim().split('\n')).toEqual([
          'READY',
          'POLLER_ABORTED',
          'STOP_REQUESTED',
          'WORKER_DRAINED',
          'DATABASE_CLOSED',
        ]);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    }
  );

  it('starts draining immediately on SIGTERM and closes SQLite last', async () => {
    const signals = new EventEmitter() as WorkerLifecycleSignalSource &
      EventEmitter;
    const workerStarted = deferred();
    const tasksStarted = deferred();
    const workerRun = deferred();
    const workerStopCalled = deferred();
    const releaseDrain = deferred();
    const events: string[] = [];
    let startedTaskCount = 0;

    const lifecycle = runWorkerLifecycle({
      backgroundTasks: ['workflow dispatcher', 'source scheduler'].map(
        (name) => ({
          name,
          run: (signal) => {
            events.push(`${name}.start`);
            startedTaskCount += 1;
            if (startedTaskCount === 2) tasksStarted.resolve();
            return new Promise<void>((resolve) => {
              signal.addEventListener(
                'abort',
                () => {
                  events.push(`${name}.abort`);
                  resolve();
                },
                { once: true }
              );
            });
          },
        })
      ),
      closeDatabase: () => events.push('database.close'),
      signalSource: signals,
      worker: {
        start: async () => {
          events.push('worker.start');
          workerStarted.resolve();
          await workerRun.promise;
        },
        stop: async () => {
          events.push('worker.stop');
          workerStopCalled.resolve();
          await releaseDrain.promise;
          events.push('worker.drained');
          workerRun.resolve();
        },
      },
    });

    await Promise.all([workerStarted.promise, tasksStarted.promise]);
    signals.emit('SIGTERM');
    await workerStopCalled.promise;
    expect(events).not.toContain('database.close');

    releaseDrain.resolve();
    await lifecycle;

    expect(events.at(-1)).toBe('database.close');
    expect(events).toContain('workflow dispatcher.abort');
    expect(events).toContain('source scheduler.abort');
    expect(events.indexOf('worker.stop')).toBeLessThan(
      events.indexOf('worker.drained')
    );
  });

  it('fails when a component exits without a shutdown signal', async () => {
    const signals = new EventEmitter() as WorkerLifecycleSignalSource &
      EventEmitter;
    const workerRun = deferred();
    let databaseClosed = false;

    await expect(
      runWorkerLifecycle({
        backgroundTasks: [
          {
            name: 'workflow dispatcher',
            run: async () => undefined,
          },
          abortableTask('source scheduler'),
        ],
        closeDatabase: () => {
          databaseClosed = true;
        },
        signalSource: signals,
        worker: {
          start: () => workerRun.promise,
          stop: async () => workerRun.resolve(),
        },
      })
    ).rejects.toThrow('workflow dispatcher stopped unexpectedly.');
    expect(databaseClosed).toBe(true);
  });

  it('propagates drain failure after closing the database', async () => {
    const signals = new EventEmitter() as WorkerLifecycleSignalSource &
      EventEmitter;
    const workerStarted = deferred();
    const workerRun = deferred();
    let databaseClosed = false;

    const lifecycle = runWorkerLifecycle({
      backgroundTasks: [abortableTask('workflow dispatcher')],
      closeDatabase: () => {
        databaseClosed = true;
      },
      signalSource: signals,
      worker: {
        start: async () => {
          workerStarted.resolve();
          await workerRun.promise;
        },
        stop: async () => {
          workerRun.resolve();
          throw new Error('hatchet drain failed');
        },
      },
    });

    await workerStarted.promise;
    signals.emit('SIGINT');
    await expect(lifecycle).rejects.toThrow('hatchet drain failed');
    expect(databaseClosed).toBe(true);
  });
});

function abortableTask(name: string) {
  return {
    name,
    run: (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => resolve(), { once: true });
      }),
  };
}

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
