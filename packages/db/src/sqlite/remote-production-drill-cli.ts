import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  assertDistinctRemoteDatabases,
  assertMatchingRemoteDrillFingerprints,
  assertRemoteDrillConfirmation,
  assertRemoteDrillPreconditions,
  assertRemoteDrillProbe,
  createRemoteDrillIdentity,
  fingerprintRemoteDrillDatabase,
  openRemoteDrillClient,
  parseRemoteDrillChallenge,
  parseRemoteDrillDatabaseConfig,
  parseRemoteDrillRunId,
  REMOTE_DRILL_OBSERVER_MARKER,
  REMOTE_DRILL_WRITER_MARKER,
  RemoteProductionDrillError,
  removeRemoteDrillProbe,
  writeRemoteDrillProbe,
  type RemoteDrillDatabaseConfig,
} from './remote-production-drill';

const CHILD_MODE_ENVIRONMENT = 'BYOK_GRID_REMOTE_DRILL_CHILD';
const CHALLENGE_ENVIRONMENT = 'BYOK_GRID_REMOTE_DRILL_CHALLENGE_SHA256';
const RUN_ID_ENVIRONMENT = 'BYOK_GRID_REMOTE_DRILL_RUN_ID';
const DEFAULT_PROCESS_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_CHILD_OUTPUT_BYTES = 4 * 1_024;
type RemoteDrillChild = ChildProcessByStdio<null, Readable, Readable>;

const [command, ...arguments_] = process.argv.slice(2);

try {
  switch (command) {
    case 'prepare':
      await prepare();
      break;
    case 'verify':
      await verify(arguments_);
      break;
    case 'cleanup':
      await cleanup(arguments_);
      break;
    case '_writer':
      await writer();
      break;
    case '_observer':
      await observer();
      break;
    default:
      usage();
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof RemoteProductionDrillError ? error.message : 'The remote libSQL production drill failed.'}\n`
  );
  process.exitCode = 1;
}

async function prepare(): Promise<void> {
  assertCoordinator();
  if (process.platform === 'win32') {
    throw new RemoteProductionDrillError(
      'The process-loss drill requires a Unix-like release environment.'
    );
  }
  const config = liveConfig();
  const identity = createRemoteDrillIdentity();
  const timeoutMilliseconds = processTimeoutMilliseconds();

  await withClient(config, assertRemoteDrillPreconditions);
  await writeJsonLine(process.stdout, {
    challengeSha256: identity.challengeSha256,
    identityCreatedAt: new Date().toISOString(),
    marker: 'BYOK_GRID_REMOTE_LIBSQL_IDENTITY_CREATED',
    runId: identity.runId,
  });
  let recoveryRequired = false;
  try {
    const writerResult = await runChild(
      '_writer',
      REMOTE_DRILL_WRITER_MARKER,
      config,
      identity,
      timeoutMilliseconds,
      { killAfterMarker: true }
    );
    if (writerResult.signal !== 'SIGKILL') {
      throw new RemoteProductionDrillError(
        'The remote libSQL writer did not terminate through the required process-loss signal.'
      );
    }
    recoveryRequired = true;
    await runChild(
      '_observer',
      REMOTE_DRILL_OBSERVER_MARKER,
      config,
      identity,
      timeoutMilliseconds
    );
  } catch (error) {
    try {
      await withClient(config, (client) =>
        removeRemoteDrillProbe(client, identity, { allowAbsent: true })
      );
      recoveryRequired = false;
    } catch {
      recoveryRequired = true;
    }
    if (recoveryRequired) {
      await writeJsonLine(process.stderr, {
        challengeSha256: identity.challengeSha256,
        marker: 'BYOK_GRID_REMOTE_LIBSQL_CLEANUP_REQUIRED',
        runId: identity.runId,
      });
    }
    throw error;
  }

  await writeJsonLine(process.stdout, {
    challengeSha256: identity.challengeSha256,
    marker: 'BYOK_GRID_REMOTE_LIBSQL_PREPARED',
    observerProcess: 'independent',
    preparedAt: new Date().toISOString(),
    runId: identity.runId,
    writerExitSignal: 'SIGKILL',
  });
}

async function verify(arguments_: readonly string[]): Promise<void> {
  assertCoordinator();
  const identity = identityFromArguments(arguments_);
  const live = liveConfig();
  const restored = restoredConfig();
  assertDistinctRemoteDatabases(live, restored);

  const [liveFingerprint, restoredFingerprint] = await Promise.all([
    inspectDatabase(live, identity),
    inspectDatabase(restored, identity),
  ]);
  assertMatchingRemoteDrillFingerprints(liveFingerprint, restoredFingerprint);

  await withClient(restored, (client) =>
    removeRemoteDrillProbe(client, identity)
  );
  await withClient(live, (client) => removeRemoteDrillProbe(client, identity));

  await writeJsonLine(process.stdout, {
    cleanup: 'complete',
    marker: 'BYOK_GRID_REMOTE_LIBSQL_RESTORE_VERIFIED',
    migrationCount: liveFingerprint.migrationCount,
    migrationSha256: liveFingerprint.migrationSha256,
    runId: identity.runId,
    schemaSha256: liveFingerprint.schemaSha256,
    tableCountsSha256: liveFingerprint.tableCountsSha256,
    verifiedAt: new Date().toISOString(),
  });
}

async function cleanup(arguments_: readonly string[]): Promise<void> {
  assertCoordinator();
  const identity = identityFromArguments(arguments_);
  await withClient(liveConfig(), (client) =>
    removeRemoteDrillProbe(client, identity)
  );
  await writeJsonLine(process.stdout, {
    cleanedAt: new Date().toISOString(),
    marker: 'BYOK_GRID_REMOTE_LIBSQL_CLEANUP_COMPLETE',
    runId: identity.runId,
  });
}

async function writer(): Promise<void> {
  assertChild();
  const identity = identityFromEnvironment();
  const client = openRemoteDrillClient(liveConfig());
  try {
    await writeRemoteDrillProbe(client, identity);
    await writeLine(process.stdout, REMOTE_DRILL_WRITER_MARKER);
    await delay(processTimeoutMilliseconds() * 2);
    throw new RemoteProductionDrillError(
      'The remote libSQL writer was not terminated by its coordinator.'
    );
  } catch (error) {
    client.close();
    throw error;
  }
}

async function observer(): Promise<void> {
  assertChild();
  const identity = identityFromEnvironment();
  await withClient(liveConfig(), (client) =>
    assertRemoteDrillProbe(client, identity)
  );
  await writeLine(process.stdout, REMOTE_DRILL_OBSERVER_MARKER);
}

async function inspectDatabase(
  config: RemoteDrillDatabaseConfig,
  identity: Readonly<{ challengeSha256: string; runId: string }>
) {
  return withClient(config, async (client) => {
    await assertRemoteDrillProbe(client, identity);
    return fingerprintRemoteDrillDatabase(client);
  });
}

async function withClient<T>(
  config: RemoteDrillDatabaseConfig,
  operation: (client: ReturnType<typeof openRemoteDrillClient>) => Promise<T>
): Promise<T> {
  const client = openRemoteDrillClient(config);
  try {
    return await operation(client);
  } finally {
    client.close();
  }
}

async function runChild(
  mode: '_observer' | '_writer',
  marker: string,
  config: RemoteDrillDatabaseConfig,
  identity: Readonly<{ challengeSha256: string; runId: string }>,
  timeoutMilliseconds: number,
  options: Readonly<{ killAfterMarker?: boolean }> = {}
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const script = fileURLToPath(import.meta.url);
  const childEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    [CHALLENGE_ENVIRONMENT]: identity.challengeSha256,
    [CHILD_MODE_ENVIRONMENT]: '1',
    [RUN_ID_ENVIRONMENT]: identity.runId,
    BYOK_GRID_REMOTE_DRILL_CONFIRM: process.env.BYOK_GRID_REMOTE_DRILL_CONFIRM,
    SQLITE_AUTH_TOKEN: config.authToken,
    SQLITE_DATABASE_URL: config.url,
  };
  delete childEnvironment.BYOK_GRID_RESTORE_AUTH_TOKEN;
  delete childEnvironment.BYOK_GRID_RESTORE_DATABASE_URL;
  const child = spawn(process.execPath, ['--import', 'tsx', script, mode], {
    env: childEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exit = childExit(child);
  try {
    await waitForMarker(child, marker, timeoutMilliseconds);
    if (options.killAfterMarker && !child.kill('SIGKILL')) {
      throw new RemoteProductionDrillError(
        'The remote libSQL writer could not receive SIGKILL.'
      );
    }
    const result = await waitForExit(exit, timeoutMilliseconds);
    if (!options.killAfterMarker && (result.code !== 0 || result.signal)) {
      throw new RemoteProductionDrillError(
        'The independent remote libSQL observer failed.'
      );
    }
    return result;
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exit;
    }
  }
}

function waitForExit(
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>,
  timeoutMilliseconds: number
) {
  return Promise.race([
    exit,
    delay(timeoutMilliseconds, undefined, { ref: false }).then(() => {
      throw new RemoteProductionDrillError(
        'The remote libSQL child did not exit within its timeout.'
      );
    }),
  ]);
}

async function waitForMarker(
  child: RemoteDrillChild,
  marker: string,
  timeoutMilliseconds: number
): Promise<void> {
  let output = '';
  let outputBytes = 0;
  const markerPromise = new Promise<void>((resolveMarker, reject) => {
    const append = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAXIMUM_CHILD_OUTPUT_BYTES) {
        reject(
          new RemoteProductionDrillError(
            'The remote libSQL child exceeded its output limit.'
          )
        );
        return;
      }
      output += chunk.toString('utf8');
      if (output.split(/\r?\n/u).includes(marker)) resolveMarker();
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('error', () =>
      reject(
        new RemoteProductionDrillError(
          'The remote libSQL child process could not start.'
        )
      )
    );
    child.once('exit', (code, signal) => {
      if (!output.split(/\r?\n/u).includes(marker)) {
        reject(
          new RemoteProductionDrillError(
            `The remote libSQL child exited before its ${marker === REMOTE_DRILL_WRITER_MARKER ? 'commit' : 'observation'} marker (${String(code)}, ${String(signal)}).`
          )
        );
      }
    });
  });
  const timeout = delay(timeoutMilliseconds, undefined, { ref: false }).then(
    () => {
      throw new RemoteProductionDrillError(
        'The remote libSQL child process exceeded its timeout.'
      );
    }
  );
  await Promise.race([markerPromise, timeout]);
}

function childExit(
  child: RemoteDrillChild
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveExit) => {
    child.once('error', () => resolveExit({ code: null, signal: null }));
    child.once('exit', (code, signal) => resolveExit({ code, signal }));
  });
}

function identityFromArguments(arguments_: readonly string[]) {
  const [runId, challengeSha256, unexpected] = arguments_;
  if (unexpected) usage();
  return {
    challengeSha256: parseRemoteDrillChallenge(challengeSha256),
    runId: parseRemoteDrillRunId(runId),
  };
}

function identityFromEnvironment() {
  return {
    challengeSha256: parseRemoteDrillChallenge(
      process.env[CHALLENGE_ENVIRONMENT]
    ),
    runId: parseRemoteDrillRunId(process.env[RUN_ID_ENVIRONMENT]),
  };
}

function liveConfig(): RemoteDrillDatabaseConfig {
  return parseRemoteDrillDatabaseConfig({
    authToken: process.env.SQLITE_AUTH_TOKEN,
    label: 'live',
    url: process.env.SQLITE_DATABASE_URL,
  });
}

function restoredConfig(): RemoteDrillDatabaseConfig {
  return parseRemoteDrillDatabaseConfig({
    authToken: process.env.BYOK_GRID_RESTORE_AUTH_TOKEN,
    label: 'restored',
    url: process.env.BYOK_GRID_RESTORE_DATABASE_URL,
  });
}

function assertCoordinator(): void {
  assertRemoteDrillConfirmation(process.env.BYOK_GRID_REMOTE_DRILL_CONFIRM);
  if (process.env[CHILD_MODE_ENVIRONMENT]) {
    throw new RemoteProductionDrillError(
      'A remote libSQL child cannot invoke a coordinator command.'
    );
  }
}

function assertChild(): void {
  assertRemoteDrillConfirmation(process.env.BYOK_GRID_REMOTE_DRILL_CONFIRM);
  if (process.env[CHILD_MODE_ENVIRONMENT] !== '1') {
    throw new RemoteProductionDrillError(
      'Remote libSQL internal child commands cannot be invoked directly.'
    );
  }
}

function processTimeoutMilliseconds(): number {
  const raw = process.env.BYOK_GRID_REMOTE_DRILL_TIMEOUT_SECONDS ?? '30';
  if (!/^\d+$/u.test(raw)) {
    throw new RemoteProductionDrillError(
      'BYOK_GRID_REMOTE_DRILL_TIMEOUT_SECONDS must be an integer from 5 through 120.'
    );
  }
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 5 || seconds > 120) {
    throw new RemoteProductionDrillError(
      'BYOK_GRID_REMOTE_DRILL_TIMEOUT_SECONDS must be an integer from 5 through 120.'
    );
  }
  return seconds * 1_000;
}

function usage(): never {
  throw new RemoteProductionDrillError(
    'Usage: drill:remote-libsql -- prepare | verify <run-id> <challenge-sha256> | cleanup <run-id> <challenge-sha256>'
  );
}

function writeJsonLine(
  stream: NodeJS.WriteStream,
  value: Readonly<Record<string, unknown>>
): Promise<void> {
  return writeLine(stream, JSON.stringify(value));
}

function writeLine(stream: NodeJS.WriteStream, value: string): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    stream.write(`${value}\n`, (error) => {
      if (error) {
        reject(
          new RemoteProductionDrillError(
            'The remote libSQL drill could not write its evidence record.'
          )
        );
        return;
      }
      resolveWrite();
    });
  });
}
