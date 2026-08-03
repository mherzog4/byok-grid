import {
  ConnectorError,
  getSandboxConnector,
  loadSandboxConnectorRegistry,
  type InstalledSandboxConnector,
} from '@byok-grid/connectors';

export function requirePinnedSandboxConnector(
  identity: {
    artifactSha256: string | null;
    connectorId: string;
    connectorVersion: string;
  },
  installed: readonly InstalledSandboxConnector[] = loadSandboxConnectorRegistry()
): InstalledSandboxConnector {
  const connector = getSandboxConnector(
    identity.connectorId,
    identity.connectorVersion,
    installed
  );
  if (!connector) {
    throw new ConnectorError(
      'invalid_input',
      `Sandbox connector ${identity.connectorId}@${identity.connectorVersion} is not installed.`,
      false
    );
  }
  if (
    identity.artifactSha256 === null ||
    connector.artifact.sha256 !== identity.artifactSha256
  ) {
    throw new ConnectorError(
      'policy',
      `Sandbox connector ${identity.connectorId}@${identity.connectorVersion} no longer matches its pinned artifact digest.`,
      false
    );
  }
  return connector;
}
