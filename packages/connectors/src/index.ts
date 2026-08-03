import {
  createConnectorManifest,
  executeAction,
  type ConnectorExecutionContext,
  type ConnectorManifest,
} from '@byok-grid/connector-sdk';
import { httpConnector } from './http';
import { hubSpotConnector } from './hubspot';
import { hunterConnector } from './hunter';
import { openAIConnector } from './openai';
import { webhookSigningCredentialSchema } from './webhook';
import {
  loadSandboxConnectorRegistry,
  type InstalledSandboxConnector,
} from './sandbox-registry';

export * from '@byok-grid/connector-sdk';
export {
  guardedEgressDispatcher,
  guardedEgressFetch,
  isBlockedEgressAddress,
} from './guarded-egress';
export { httpConnector, httpCredentialSchema } from './http';
export {
  HUBSPOT_API_HOST,
  hubSpotConnector,
  hubSpotCredentialSchema,
  HubSpotWritebackError,
} from './hubspot';
export { hunterConnector, hunterCredentialSchema } from './hunter';
export { openAIConnector, openAICredentialSchema } from './openai';
export {
  webhookSigningCredentialSchema,
  type WebhookSigningCredential,
} from './webhook';
export {
  buildWebhookHeaders,
  classifyWebhookStatus,
  WebhookHttpError,
} from './webhook-delivery-policy';
export {
  loadSandboxConnectorRegistry,
  parseSandboxConnectorRegistry,
  summarizeInstalledSandboxConnectors,
  type InstalledSandboxConnectorSummary,
  type InstalledSandboxConnector,
} from './sandbox-registry';
export {
  executeSandboxConnector,
  sandboxEffectBudget,
  signSandboxRunnerRequest,
  type SandboxConnectorExecution,
  type SandboxRunnerClientConfig,
} from './sandbox-runner-client';
export {
  compileSandboxJsonSchema,
  sandboxJsonSchemaMatches,
} from './sandbox-schema';

export const builtInConnectorManifests: readonly ConnectorManifest[] = [
  createConnectorManifest(httpConnector),
  createConnectorManifest(hunterConnector),
  createConnectorManifest(openAIConnector),
];

export function getBuiltInConnectorManifest(
  connectorId: string
): ConnectorManifest | undefined {
  return builtInConnectorManifests.find(
    (manifest) => manifest.id === connectorId
  );
}

export function listConnectorManifests(
  sandboxConnectors: readonly InstalledSandboxConnector[] = loadSandboxConnectorRegistry()
): readonly ConnectorManifest[] {
  return [
    ...builtInConnectorManifests,
    ...sandboxConnectors
      .filter(({ catalog }) => catalog)
      .map(({ manifest }) => manifest),
  ];
}

export function getConnectorManifest(
  connectorId: string,
  connectorVersion?: string,
  sandboxConnectors: readonly InstalledSandboxConnector[] = loadSandboxConnectorRegistry()
): ConnectorManifest | undefined {
  if (connectorVersion !== undefined) {
    const builtIn = getBuiltInConnectorManifest(connectorId);
    if (builtIn?.version === connectorVersion) return builtIn;
    return sandboxConnectors.find(
      ({ manifest }) =>
        manifest.id === connectorId && manifest.version === connectorVersion
    )?.manifest;
  }
  return listConnectorManifests(sandboxConnectors).find(
    (manifest) => manifest.id === connectorId
  );
}

export function getSandboxConnector(
  connectorId: string,
  connectorVersion: string,
  sandboxConnectors: readonly InstalledSandboxConnector[] = loadSandboxConnectorRegistry()
): InstalledSandboxConnector | undefined {
  return sandboxConnectors.find(
    ({ manifest }) =>
      manifest.id === connectorId && manifest.version === connectorVersion
  );
}

export function getBuiltInCredentialSchema(connectorId: string) {
  if (connectorId === httpConnector.id) return httpConnector.credentialSchema;
  if (connectorId === hunterConnector.id)
    return hunterConnector.credentialSchema;
  if (connectorId === hubSpotConnector.id)
    return hubSpotConnector.credentialSchema;
  if (connectorId === openAIConnector.id)
    return openAIConnector.credentialSchema;
  if (connectorId === 'webhook') return webhookSigningCredentialSchema;
  return undefined;
}

export function getBuiltInActionPolicy(connectorId: string, actionId: string) {
  return getBuiltInConnectorManifest(connectorId)?.actions.find(
    (action) => action.id === actionId
  )?.hostPolicy;
}

export function getBuiltInActionCellOutput(
  connectorId: string,
  actionId: string
) {
  return getBuiltInConnectorManifest(connectorId)?.actions.find(
    (action) => action.id === actionId
  )?.cellOutput;
}

export async function executeBuiltInAction(args: {
  actionId: string;
  connectorId: string;
  context: ConnectorExecutionContext;
  credential: unknown;
  input: unknown;
}): Promise<unknown> {
  if (args.connectorId === httpConnector.id && args.actionId === 'request') {
    return executeAction({
      action: httpConnector.actions.request,
      context: args.context,
      credential: args.credential,
      credentialSchema: httpConnector.credentialSchema,
      input: args.input,
    });
  }
  if (
    args.connectorId === hunterConnector.id &&
    args.actionId === 'domain_search'
  ) {
    return executeAction({
      action: hunterConnector.actions.domain_search,
      context: args.context,
      credential: args.credential,
      credentialSchema: hunterConnector.credentialSchema,
      input: args.input,
    });
  }
  if (
    args.connectorId === openAIConnector.id &&
    args.actionId === 'generate_text'
  ) {
    return executeAction({
      action: openAIConnector.actions.generate_text,
      context: args.context,
      credential: args.credential,
      credentialSchema: openAIConnector.credentialSchema,
      input: args.input,
    });
  }
  throw new Error(
    `Unknown connector action ${args.connectorId}.${args.actionId}.`
  );
}
