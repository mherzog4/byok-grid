export type WorkerShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface WorkerLifecycleSignalSource {
  once(event: WorkerShutdownSignal, listener: () => void): unknown;
  removeListener(event: WorkerShutdownSignal, listener: () => void): unknown;
}

export interface WorkerLifecycleTask {
  name: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface WorkerLifecycleHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export async function runWorkerLifecycle(input: {
  backgroundTasks: readonly WorkerLifecycleTask[];
  closeDatabase: () => void;
  signalSource: WorkerLifecycleSignalSource;
  worker: WorkerLifecycleHandle;
}): Promise<void> {
  const controller = new AbortController();
  const shutdown = deferred();
  const requestShutdown = () => shutdown.resolve();

  input.signalSource.once('SIGINT', requestShutdown);
  input.signalSource.once('SIGTERM', requestShutdown);

  const workerRun = Promise.resolve().then(() => input.worker.start());
  const backgroundRuns = input.backgroundTasks.map((task) => ({
    name: task.name,
    promise: Promise.resolve().then(() => task.run(controller.signal)),
  }));
  let runtimeError: unknown;

  try {
    const firstStop = await Promise.race([
      shutdown.promise.then(() => ({ kind: 'signal' as const })),
      workerRun.then(() => ({
        kind: 'component' as const,
        name: 'hatchet worker',
      })),
      ...backgroundRuns.map(({ name, promise }) =>
        promise.then(() => ({ kind: 'component' as const, name }))
      ),
    ]);

    if (firstStop.kind === 'component') {
      throw new Error(`${firstStop.name} stopped unexpectedly.`);
    }
  } catch (error) {
    runtimeError = error;
  } finally {
    controller.abort();
    const cleanupResults = await Promise.allSettled([
      Promise.resolve().then(() => input.worker.stop()),
      workerRun,
      ...backgroundRuns.map(({ promise }) => promise),
    ]);

    input.signalSource.removeListener('SIGINT', requestShutdown);
    input.signalSource.removeListener('SIGTERM', requestShutdown);

    runtimeError ??= cleanupResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )?.reason;

    try {
      input.closeDatabase();
    } catch (error) {
      runtimeError ??= error;
    }
  }

  if (runtimeError) throw runtimeError;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
