#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  parseKubernetesVerificationEnvironment,
  readReleaseDigestManifest,
  validateKubernetesContext,
  verifyKubernetesRuntime,
} from './verify-kubernetes-runtime-lib.mjs';

const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
let config;

try {
  if (process.platform === 'win32') {
    throw new Error(
      'The Kubernetes verifier requires a Unix-like operator host.'
    );
  }
  config = parseKubernetesVerificationEnvironment(process.env);
  validateKubernetesContext(
    await kubectlOutput(['config', 'current-context'], false),
    config.context
  );
  const manifest = readReleaseDigestManifest(config.digestManifestPath);
  const version = await kubectlJson(['version', '--output=json'], true);
  const resources = await kubectlJson(
    [
      'get',
      [
        'deployments.apps',
        'horizontalpodautoscalers.autoscaling',
        'ingresses.networking.k8s.io',
        'jobs.batch',
        'networkpolicies.networking.k8s.io',
        'poddisruptionbudgets.policy',
        'pods',
        'services',
      ].join(','),
      `--selector=app.kubernetes.io/instance=${config.release}`,
      '--output=json',
    ],
    true
  );
  const result = verifyKubernetesRuntime(resources, {
    clusterVersion: version?.serverVersion?.gitVersion,
    config,
    manifest,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `Kubernetes runtime verification failed: ${safeMessage(error)}\n`
  );
  process.exitCode = 1;
}

async function kubectlJson(args, scoped) {
  const output = await kubectlOutput(args, scoped);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('kubectl returned malformed JSON.');
  }
}

function kubectlOutput(args, scoped) {
  return new Promise((resolve, reject) => {
    const prefix = scoped
      ? [
          '--context',
          config.context,
          '--namespace',
          config.namespace,
          '--request-timeout=20s',
        ]
      : ['--request-timeout=20s'];
    const child = spawn('kubectl', [...prefix, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    const deadline = setTimeout(() => child.kill('SIGKILL'), 30_000);
    deadline.unref();
    child.once('error', () => {
      clearTimeout(deadline);
      reject(new Error('kubectl could not start.'));
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (overflow) {
        reject(new Error('kubectl output exceeded the verifier limit.'));
      } else if (code !== 0) {
        reject(new Error('kubectl could not complete a read-only check.'));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8').trim());
      }
    });
  });
}

function safeMessage(error) {
  if (error instanceof Error && error.message.length <= 500) {
    return error.message;
  }
  return 'Unknown bounded verification failure.';
}
