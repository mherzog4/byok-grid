#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  buildKubernetesSecretProvenanceEvidence,
  inspectExternalSecret,
  inspectExternalSecretsControllerDeployment,
  inspectExternalSecretsControllerPods,
  inspectSecretStore,
  kubernetesLabelSelector,
  parseKubernetesSecretProvenanceEnvironment,
  validateKubernetesSecretContext,
} from './verify-kubernetes-secret-provenance-lib.mjs';

const MAXIMUM_OUTPUT_BYTES = 2 * 1024 * 1024;
const KUBECTL_TIMEOUT_MS = 30_000;
let config;

try {
  if (process.platform === 'win32') {
    throw new Error(
      'The Kubernetes secret provenance verifier requires a Unix-like operator host.'
    );
  }
  config = parseKubernetesSecretProvenanceEnvironment(process.env);
  validateKubernetesSecretContext(
    await kubectlOutput(['config', 'current-context'], {}),
    config.context
  );
  const externalSecretResource = await kubectlJson(
    [
      'get',
      'externalsecret.external-secrets.io',
      config.externalSecretName,
      '--output=json',
    ],
    { namespace: config.namespace, useContext: true }
  );
  const externalSecret = inspectExternalSecret(externalSecretResource, config);
  const storeResource = await kubectlJson(
    [
      'get',
      config.storeKind === 'SecretStore'
        ? 'secretstore.external-secrets.io'
        : 'clustersecretstore.external-secrets.io',
      config.storeName,
      '--output=json',
    ],
    {
      namespace:
        config.storeKind === 'SecretStore' ? config.namespace : undefined,
      useContext: true,
    }
  );
  const store = inspectSecretStore(storeResource, config);
  const deploymentResource = await kubectlJson(
    ['get', 'deployment.apps', config.controllerDeployment, '--output=json'],
    { namespace: config.controllerNamespace, useContext: true }
  );
  const deployment = inspectExternalSecretsControllerDeployment(
    deploymentResource,
    config
  );
  const podResources = await kubectlJson(
    [
      'get',
      'pods',
      `--selector=${kubernetesLabelSelector(deployment.matchLabels)}`,
      '--output=json',
    ],
    { namespace: config.controllerNamespace, useContext: true }
  );
  const controller = inspectExternalSecretsControllerPods(
    podResources,
    config,
    deployment
  );
  process.stdout.write(
    `${JSON.stringify(
      buildKubernetesSecretProvenanceEvidence({
        config,
        controller,
        externalSecret,
        store,
      })
    )}\n`
  );
} catch (error) {
  process.stderr.write(
    `Kubernetes secret provenance verification failed: ${safeMessage(error)}\n`
  );
  process.exitCode = 1;
}

async function kubectlJson(args, options) {
  const output = await kubectlOutput(args, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new Error('kubectl returned malformed JSON.');
  }
}

function kubectlOutput(args, { namespace, useContext = false }) {
  return new Promise((resolve, reject) => {
    const prefix = [
      '--request-timeout=20s',
      ...(useContext ? ['--context', config.context] : []),
      ...(namespace ? ['--namespace', namespace] : []),
    ];
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
    const timer = setTimeout(() => child.kill('SIGKILL'), KUBECTL_TIMEOUT_MS);
    timer.unref();
    child.once('error', () => {
      clearTimeout(timer);
      reject(new Error('kubectl could not start.'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
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
  return 'Unknown bounded secret provenance verification failure.';
}
