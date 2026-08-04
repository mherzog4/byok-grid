#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  buildNetworkPolicyEvidence,
  createNetworkProbePod,
  inspectCompletedProbePod,
  inspectCreatedProbePod,
  inspectDrillNamespace,
  networkPolicyDrillRunId,
  parseNetworkPolicyDrillEnvironment,
  parseNetworkProbeLog,
  probeExecutionOrder,
  readNetworkPolicyPlan,
  sourceNamespace,
  sourcePodLabels,
} from './drill-kubernetes-network-policy-lib.mjs';
import {
  readReleaseDigestManifest,
  validateKubernetesContext,
} from './verify-kubernetes-runtime-lib.mjs';

const MAXIMUM_OUTPUT_BYTES = 1024 * 1024;
const KUBECTL_TIMEOUT_MS = 30_000;
let activeChild;
let config;
let interruptedSignal;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    interruptedSignal = signal;
    activeChild?.kill('SIGTERM');
  });
}

try {
  if (process.platform === 'win32') {
    throw new Error(
      'The Kubernetes NetworkPolicy drill requires a Unix-like operator host.'
    );
  }
  config = parseNetworkPolicyDrillEnvironment(process.env);
  validateKubernetesContext(
    await kubectlOutput(['config', 'current-context'], { useContext: false }),
    config.context
  );
  const manifest = readReleaseDigestManifest(config.digestManifestPath);
  const plan = readNetworkPolicyPlan(
    config.planPath,
    config.optionalComponents
  );
  const externalNamespaceNames = Object.values(plan.namespaces).map(
    ({ name }) => name
  );
  if (
    externalNamespaceNames.includes(config.releaseNamespace) ||
    ['default', 'kube-node-lease', 'kube-public', 'kube-system'].includes(
      config.releaseNamespace
    )
  ) {
    throw new Error(
      'The release drill namespace must be distinct and non-system.'
    );
  }

  await inspectNamespace(config.releaseNamespace, {
    'byok-grid.dev/network-drill': 'isolated',
  });
  for (const descriptor of Object.values(plan.namespaces)) {
    await inspectNamespace(descriptor.name, descriptor.namespaceLabels);
  }

  const maintenance = manifest.byTarget.get('maintenance');
  if (!maintenance) throw new Error('The release manifest is incomplete.');
  const runId = networkPolicyDrillRunId();
  const deadline = Date.now() + config.totalTimeoutMs;
  const results = [];
  const probes = probeExecutionOrder(plan.probes);
  for (const [index, probe] of probes.entries()) {
    checkInterrupted();
    if (Date.now() >= deadline) {
      throw new Error('The NetworkPolicy drill exceeded its total deadline.');
    }
    const namespace = sourceNamespace(probe, plan, config.releaseNamespace);
    const target = plan.targetsById.get(probe.target);
    const pod = createNetworkProbePod({
      appName: config.appName,
      connectTimeoutMs: config.connectTimeoutMs,
      image: maintenance.image,
      index,
      namespace,
      podLabels: sourcePodLabels(probe, plan),
      probe,
      release: config.release,
      runId,
      target,
    });
    results.push(await executeProbe({ deadline, namespace, pod, probe }));
  }

  process.stdout.write(
    `${JSON.stringify(
      buildNetworkPolicyEvidence({
        config,
        manifest,
        plan,
        results,
        runId,
      })
    )}\n`
  );
} catch (error) {
  process.stderr.write(
    `Kubernetes NetworkPolicy drill failed: ${safeMessage(error)}\n`
  );
  process.exitCode = interruptedSignal === 'SIGINT' ? 130 : 1;
}

async function inspectNamespace(name, expectedLabels) {
  const response = await kubectlJson(
    ['get', 'namespace', name, '--output=json'],
    {}
  );
  inspectDrillNamespace(response, name, expectedLabels);
}

async function executeProbe({ deadline, namespace, pod, probe }) {
  let failure;
  let result;
  try {
    const created = await kubectlJson(
      ['create', '--filename=-', '--output=json'],
      {
        input: `${JSON.stringify(pod)}\n`,
        namespace,
      }
    );
    inspectCreatedProbePod(created, pod);
    const completed = await waitForProbePod(
      namespace,
      pod.metadata.name,
      deadline
    );
    inspectCompletedProbePod(completed);
    const log = await kubectlOutput(
      ['logs', pod.metadata.name, '--container=probe'],
      { namespace }
    );
    const observed = parseNetworkProbeLog(log, probe.expectation).observed;
    result = {
      claim: probe.claim,
      expectation: probe.expectation,
      observed,
      target: probe.target,
    };
  } catch (error) {
    failure = error;
  }

  try {
    await kubectlOutput(
      [
        'delete',
        'pod',
        pod.metadata.name,
        '--ignore-not-found=true',
        '--wait=true',
        '--timeout=30s',
      ],
      { namespace }
    );
  } catch {
    if (!failure) {
      failure = new Error('A network probe Pod could not be cleaned up.');
    }
  }
  if (failure) throw failure;
  return result;
}

async function waitForProbePod(namespace, name, deadline) {
  while (Date.now() < deadline) {
    checkInterrupted();
    const pod = await kubectlJson(['get', 'pod', name, '--output=json'], {
      namespace,
    });
    if (['Failed', 'Succeeded'].includes(pod?.status?.phase)) return pod;
    await delay(250);
  }
  throw new Error('A network probe Pod did not finish before the deadline.');
}

async function kubectlJson(args, options) {
  const output = await kubectlOutput(args, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('kubectl returned malformed JSON.');
  }
}

function kubectlOutput(args, { input, namespace, useContext = true }) {
  return new Promise((resolve, reject) => {
    checkInterrupted();
    const prefix = [
      '--request-timeout=20s',
      ...(config && useContext ? ['--context', config.context] : []),
      ...(namespace ? ['--namespace', namespace] : []),
    ];
    const child = spawn('kubectl', [...prefix, ...args], {
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    activeChild = child;
    const chunks = [];
    let bytes = 0;
    let overflow = false;
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAXIMUM_OUTPUT_BYTES) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.resume();
    if (input !== undefined) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), KUBECTL_TIMEOUT_MS);
    timer.unref();
    child.once('error', () => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      reject(new Error('kubectl could not start.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (activeChild === child) activeChild = undefined;
      if (overflow) {
        reject(new Error('kubectl output exceeded the drill limit.'));
      } else if (code !== 0) {
        reject(new Error('kubectl could not complete a bounded drill step.'));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8').trim());
      }
    });
  });
}

function checkInterrupted() {
  if (interruptedSignal) {
    throw new Error('The NetworkPolicy drill was interrupted.');
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeMessage(error) {
  if (error instanceof Error && error.message.length <= 500) {
    return error.message;
  }
  return 'Unknown bounded NetworkPolicy drill failure.';
}
