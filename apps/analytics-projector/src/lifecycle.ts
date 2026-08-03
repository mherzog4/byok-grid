import { setTimeout as delay } from 'node:timers/promises';

export type AnalyticsProjectorShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface AnalyticsProjectorSignalSource {
  once(event: AnalyticsProjectorShutdownSignal, listener: () => void): unknown;
  removeListener(
    event: AnalyticsProjectorShutdownSignal,
    listener: () => void
  ): unknown;
}

export interface AnalyticsProjectorHealthLifecycle {
  close(): Promise<void>;
  listen(): Promise<void>;
  setReady(ready: boolean): void;
}

export async function runAnalyticsProjectorLifecycle(input: {
  closeDatabase: () => void;
  ensureSchema: (signal: AbortSignal) => Promise<void>;
  eraseBatch: (signal: AbortSignal) => Promise<number>;
  health: AnalyticsProjectorHealthLifecycle;
  pollMilliseconds: number;
  projectBatch: (signal: AbortSignal) => Promise<number>;
  reportFailure: (
    phase: 'initialization' | 'projection',
    error: unknown
  ) => void;
  signalSource: AnalyticsProjectorSignalSource;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
  const controller = new AbortController();
  const requestShutdown = () => {
    input.health.setReady(false);
    controller.abort();
  };
  const wait = input.wait ?? waitWithSignal;
  let runtimeError: unknown;

  input.signalSource.once('SIGINT', requestShutdown);
  input.signalSource.once('SIGTERM', requestShutdown);

  try {
    await input.health.listen();
    while (!controller.signal.aborted) {
      try {
        await input.ensureSchema(controller.signal);
        if (!controller.signal.aborted) input.health.setReady(true);
        break;
      } catch (error) {
        if (controller.signal.aborted) break;
        input.reportFailure('initialization', error);
        await waitForNextCycle(wait, input.pollMilliseconds, controller.signal);
      }
    }

    while (!controller.signal.aborted) {
      try {
        const erased = await input.eraseBatch(controller.signal);
        const projected = controller.signal.aborted
          ? 0
          : await input.projectBatch(controller.signal);
        if (erased + projected === 0) {
          await waitForNextCycle(
            wait,
            input.pollMilliseconds,
            controller.signal
          );
        }
      } catch (error) {
        if (controller.signal.aborted) break;
        input.reportFailure('projection', error);
        await waitForNextCycle(wait, input.pollMilliseconds, controller.signal);
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) runtimeError = error;
  } finally {
    input.health.setReady(false);
    controller.abort();
    input.signalSource.removeListener('SIGINT', requestShutdown);
    input.signalSource.removeListener('SIGTERM', requestShutdown);

    try {
      await input.health.close();
    } catch (error) {
      runtimeError ??= error;
    }
    try {
      input.closeDatabase();
    } catch (error) {
      runtimeError ??= error;
    }
  }

  if (runtimeError) throw runtimeError;
}

async function waitForNextCycle(
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  try {
    await wait(milliseconds, signal);
  } catch (error) {
    if (!signal.aborted) throw error;
  }
}

function waitWithSignal(
  milliseconds: number,
  signal: AbortSignal
): Promise<void> {
  return delay(milliseconds, undefined, { signal });
}
