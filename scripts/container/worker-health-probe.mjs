import { pathToFileURL } from 'node:url';

const recognizedStatuses = new Set([
  'INITIALIZED',
  'STARTING',
  'HEALTHY',
  'UNHEALTHY',
]);

export async function checkWorkerHealth(
  mode,
  {
    fetchImpl = globalThis.fetch,
    url = workerHealthUrl(process.env.HATCHET_CLIENT_WORKER_HEALTHCHECK_PORT),
  } = {}
) {
  if (mode !== 'live' && mode !== 'ready') return false;

  try {
    const response = await fetchImpl(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(2_000),
    });
    const body = await response.json();
    const status =
      body && typeof body === 'object' && typeof body.status === 'string'
        ? body.status
        : undefined;

    if (mode === 'ready') return response.ok && status === 'HEALTHY';
    return status !== undefined && recognizedStatuses.has(status);
  } catch {
    return false;
  }
}

function workerHealthUrl(rawPort) {
  if (!rawPort || !/^\d+$/u.test(rawPort)) return undefined;
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
    return undefined;
  }
  return `http://127.0.0.1:${port}/health`;
}

function isMainModule() {
  const entrypoint = process.argv[1];
  return Boolean(
    entrypoint && import.meta.url === pathToFileURL(entrypoint).href
  );
}

if (isMainModule()) {
  const healthy = await checkWorkerHealth(process.argv[2]);
  if (!healthy) process.exitCode = 1;
}
