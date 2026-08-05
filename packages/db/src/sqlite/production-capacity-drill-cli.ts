import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { assertRemoteDrillPreconditions } from './remote-production-drill';
import {
  CAPACITY_DRILL_MARKER,
  CAPACITY_WORKER_OBSERVATION_SCRIPT,
  ProductionCapacityDrillError,
  assertCapacityCleanupState,
  cleanupCapacityFixture,
  compareCapacityWorkerObservations,
  createCapacityFixture,
  createCapacityWorkflow,
  inspectCapacityWorkerDeployment,
  inspectCapacityWorkerPods,
  inspectCapacityWebDeployment,
  openProductionCapacityClient,
  parseCapacityWorkerObservation,
  parseProductionCapacityConfig,
  runCapacityWorkload,
  safeProductionCapacityMessage,
  assertSameKubectlContext,
  type CapacityFixture,
  type CapacityWorkerObservation,
  type ProductionCapacityConfig,
} from './production-capacity-drill';

let client: ReturnType<typeof openProductionCapacityClient> | undefined;
let config: ProductionCapacityConfig | undefined;
let fixture: CapacityFixture | undefined;
const runId = randomUUID();
let cleanupVerified = false;

try {
  if (process.platform === 'win32') {
    throw new ProductionCapacityDrillError(
      'The production capacity drill requires a Unix-like host.'
    );
  }
  config = parseProductionCapacityConfig(process.env);
  assertSameKubectlContext(
    await kubectlOutput(config, ['config', 'current-context']),
    config.kubectlContext
  );

  const deployment = inspectCapacityWorkerDeployment(
    await kubectlJson(config, [
      'get',
      'deployment',
      config.workerDeployment,
      '--output=json',
    ]),
    config.profile.expectedWorkerReplicas
  );
  const webDeployment = inspectCapacityWebDeployment(
    await kubectlJson(config, [
      'get',
      'deployment',
      config.webDeployment,
      '--output=json',
    ]),
    config.profile.expectedWebReplicas
  );
  const initialPods = inspectCapacityWorkerPods(
    await kubectlJson(config, [
      'get',
      'pods',
      `--selector=${deployment.selector}`,
      '--output=json',
    ]),
    config.profile.expectedWorkerReplicas
  );
  const initialWorkers = await observeWorkers(config, initialPods);

  client = openProductionCapacityClient(config);
  await assertRemoteDrillPreconditions(client);
  fixture = await createCapacityFixture({ client, config, runId });
  const workflow = await createCapacityWorkflow({ config, fixture });
  const measured = await runCapacityWorkload({ config, fixture, workflow });

  const finalDeployment = inspectCapacityWorkerDeployment(
    await kubectlJson(config, [
      'get',
      'deployment',
      config.workerDeployment,
      '--output=json',
    ]),
    config.profile.expectedWorkerReplicas
  );
  const finalWebDeployment = inspectCapacityWebDeployment(
    await kubectlJson(config, [
      'get',
      'deployment',
      config.webDeployment,
      '--output=json',
    ]),
    config.profile.expectedWebReplicas
  );
  if (
    finalDeployment.selector !== deployment.selector ||
    finalDeployment.imageDigest !== deployment.imageDigest ||
    finalWebDeployment.selector !== webDeployment.selector ||
    finalWebDeployment.imageDigest !== webDeployment.imageDigest
  ) {
    throw new ProductionCapacityDrillError(
      'A measured deployment selector or image digest changed during the drill.'
    );
  }
  const finalPods = inspectCapacityWorkerPods(
    await kubectlJson(config, [
      'get',
      'pods',
      `--selector=${deployment.selector}`,
      '--output=json',
    ]),
    config.profile.expectedWorkerReplicas
  );
  const finalWorkers = await observeWorkers(config, finalPods);
  const workerContention = compareCapacityWorkerObservations(
    initialWorkers,
    finalWorkers,
    config.profile.maxWorkerWriteRetries
  );

  await cleanupCapacityFixture(client, fixture);
  await assertCapacityCleanupState(client);
  fixture = undefined;
  cleanupVerified = true;

  process.stdout.write(
    `${JSON.stringify({
      candidateSha: config.candidateSha,
      cleanupVerified,
      imageDigests: {
        web: webDeployment.imageDigest,
        worker: deployment.imageDigest,
      },
      marker: CAPACITY_DRILL_MARKER,
      measured,
      profile: config.profile,
      runId,
      verifiedAt: new Date().toISOString(),
      workerContention,
    })}\n`
  );
} catch (error) {
  process.stderr.write(
    `Production capacity drill failed: ${safeProductionCapacityMessage(error)}\n`
  );
  process.exitCode = 1;
} finally {
  if (client && fixture) {
    try {
      await cleanupCapacityFixture(client, fixture);
      await assertCapacityCleanupState(client);
      cleanupVerified = true;
    } catch {
      process.stderr.write(
        `${JSON.stringify({
          marker: 'BYOK_GRID_PRODUCTION_CAPACITY_CLEANUP_REQUIRED',
          runId,
        })}\n`
      );
      process.exitCode = 1;
    }
  }
  client?.close();
}

async function observeWorkers(
  capacityConfig: ProductionCapacityConfig,
  pods: readonly { name: string; restartCount: number; uid: string }[]
): Promise<CapacityWorkerObservation[]> {
  return Promise.all(
    pods.map(async (pod) => {
      const raw = await kubectlOutput(capacityConfig, [
        'exec',
        pod.name,
        '--container=worker',
        '--',
        'node',
        '--eval',
        CAPACITY_WORKER_OBSERVATION_SCRIPT,
      ]);
      let parsed;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        throw new ProductionCapacityDrillError(
          'A worker observation returned malformed JSON.'
        );
      }
      return parseCapacityWorkerObservation(pod, parsed);
    })
  );
}

async function kubectlJson(
  capacityConfig: ProductionCapacityConfig,
  args: readonly string[]
): Promise<unknown> {
  const output = await kubectlOutput(capacityConfig, args);
  try {
    return JSON.parse(output) as unknown;
  } catch {
    throw new ProductionCapacityDrillError('kubectl returned malformed JSON.');
  }
}

async function kubectlOutput(
  capacityConfig: ProductionCapacityConfig,
  args: readonly string[]
): Promise<string> {
  const chunks: Buffer[] = [];
  const child = spawn(
    'kubectl',
    [
      '--context',
      capacityConfig.kubectlContext,
      '--namespace',
      capacityConfig.namespace,
      '--request-timeout=15s',
      ...args,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let bytes = 0;
  child.stdout.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes <= 1_048_576) chunks.push(chunk);
  });
  child.stderr.resume();
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000);
  deadline.unref();
  const exit = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(deadline));
  if (exit.code !== 0) {
    throw new ProductionCapacityDrillError(
      'kubectl could not complete a capacity check.'
    );
  }
  return Buffer.concat(chunks).toString().trim();
}
