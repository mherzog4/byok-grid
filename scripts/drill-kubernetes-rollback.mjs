#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  executeKubernetesRollbackDrill,
  helmRollbackArguments,
  parseRollbackEnvironment,
} from './drill-kubernetes-rollback-lib.mjs';
import { readReleaseDigestManifest } from './verify-kubernetes-runtime-lib.mjs';
import { verifyPublicDeployment } from './verify-public-deployment.mjs';

const MAXIMUM_OUTPUT_BYTES = 4 * 1024 * 1024;
let config;
let interruptedSignal;

const interrupt = (signal) => {
  interruptedSignal ??= signal;
};
const interruptWithSigint = () => interrupt('SIGINT');
const interruptWithSigterm = () => interrupt('SIGTERM');
process.on('SIGINT', interruptWithSigint);
process.on('SIGTERM', interruptWithSigterm);

try {
  if (process.platform === 'win32') {
    throw new Error(
      'The Kubernetes rollback drill requires a Unix-like operator host.'
    );
  }
  config = parseRollbackEnvironment(process.env);
  const candidate = readReleaseDigestManifest(
    config.candidateDigestManifestPath
  );
  const previous = readReleaseDigestManifest(config.previousDigestManifestPath);
  const evidence = await executeKubernetesRollbackDrill({
    config,
    manifests: { candidate, previous },
    operations: {
      assertContinuation() {
        if (interruptedSignal) {
          throw new Error(
            'The operator interrupted the drill; candidate restoration was required.'
          );
        }
      },
      currentContext: () => kubectlOutput(['config', 'current-context'], false),
      helmVersion: () =>
        commandOutput('helm', ['version', '--template={{.Version}}'], 30_000),
      history: () => helmJson(['history', config.release, '--max=256']),
      resources: () =>
        kubectlJson(
          [
            'get',
            'deployments.apps,pods',
            `--selector=app.kubernetes.io/instance=${config.release}`,
            '--output=json',
          ],
          true
        ),
      rollback: (revision) =>
        helmOutput(helmRollbackArguments(config, revision)),
      verifyPublic: (origin) => verifyPublicDeployment({ origin }),
    },
  });
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  process.stderr.write(
    `Kubernetes rollback drill failed: ${safeMessage(error)}\n`
  );
  process.exitCode =
    interruptedSignal === 'SIGINT'
      ? 130
      : interruptedSignal === 'SIGTERM'
        ? 143
        : 1;
} finally {
  process.off('SIGINT', interruptWithSigint);
  process.off('SIGTERM', interruptWithSigterm);
}

async function helmJson(args) {
  const output = await helmOutput([...args, '--output=json']);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('Helm returned malformed JSON.');
  }
}

function helmOutput(args) {
  return commandOutput(
    'helm',
    [
      ...args,
      `--kube-context=${config.context}`,
      `--namespace=${config.namespace}`,
    ],
    11 * 60_000
  );
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
  return commandOutput(
    'kubectl',
    [
      ...(scoped
        ? [`--context=${config.context}`, `--namespace=${config.namespace}`]
        : []),
      '--request-timeout=20s',
      ...args,
    ],
    30_000
  );
}

function commandOutput(command, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let bytes = 0;
    let overflow = false;
    let timedOut = false;
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
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    deadline.unref();
    child.once('error', () => {
      clearTimeout(deadline);
      reject(new Error(`${command} could not start.`));
    });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (overflow) {
        reject(new Error(`${command} output exceeded the drill limit.`));
      } else if (timedOut) {
        reject(new Error(`${command} exceeded the drill deadline.`));
      } else if (code !== 0) {
        reject(new Error(`${command} could not complete the rollback check.`));
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
  return 'Unknown bounded rollback-drill failure.';
}
