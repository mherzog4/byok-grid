import { setTimeout as delay } from 'node:timers/promises';

export class WebDrainObservationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebDrainObservationError';
  }
}

export function isConnectionRejection(error) {
  return error?.code === 'ECONNREFUSED' || error?.code === 'ECONNRESET';
}

export async function observeListenerClosure({
  canConnect,
  isProcessExited,
  isRequestSettled,
  now = () => performance.now(),
  pollIntervalMilliseconds = 10,
  sleep = (milliseconds) => delay(milliseconds),
  startedAt,
  timeoutMilliseconds = 10_000,
}) {
  if (
    typeof canConnect !== 'function' ||
    typeof isProcessExited !== 'function' ||
    typeof isRequestSettled !== 'function'
  ) {
    throw new TypeError('Web drain observation callbacks are required.');
  }
  if (!Number.isFinite(startedAt)) {
    throw new TypeError('Web drain observation requires a finite start time.');
  }
  if (
    !Number.isInteger(pollIntervalMilliseconds) ||
    pollIntervalMilliseconds < 1 ||
    !Number.isInteger(timeoutMilliseconds) ||
    timeoutMilliseconds < pollIntervalMilliseconds
  ) {
    throw new TypeError('Web drain observation timing is invalid.');
  }

  const deadline = startedAt + timeoutMilliseconds;
  while (now() < deadline) {
    const acceptingConnections = await canConnect();
    const processExited = isProcessExited();
    const requestSettled = isRequestSettled();

    if (!acceptingConnections && !processExited && !requestSettled) {
      return Math.round(now() - startedAt);
    }
    if (processExited) {
      throw new WebDrainObservationError(
        'The web process exited before listener closure was observed while the in-flight request was pending.'
      );
    }
    if (requestSettled) {
      throw new WebDrainObservationError(
        'The in-flight request completed before listener closure was observed.'
      );
    }
    await sleep(pollIntervalMilliseconds);
  }

  throw new WebDrainObservationError(
    `The web listener continued accepting new connections for ${Math.round(now() - startedAt)}ms after SIGTERM.`
  );
}
