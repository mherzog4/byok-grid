import { loadSandboxConnectorRegistry } from '@byok-grid/connectors';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requirePinnedSandboxConnector } from './sandbox-execution-policy';

const installed = loadSandboxConnectorRegistry(
  resolve(
    import.meta.dirname,
    '../../../examples/connectors/reference/registry.json'
  ),
  {
    allowUnsigned: false,
    trustedPublicKeys: {
      byok_grid_reference_2026:
        'd30d04cc80d66bff277650ce03561ed543a321921199f48de5c20355bb213e86',
    },
  }
);

describe('sandbox execution provenance', () => {
  it('resolves only the exact installed artifact bytes', () => {
    const connector = installed[0]!;
    expect(
      requirePinnedSandboxConnector(
        {
          artifactSha256: connector.artifact.sha256,
          connectorId: connector.manifest.id,
          connectorVersion: connector.manifest.version,
        },
        installed
      )
    ).toBe(connector);
  });

  it('rejects legacy missing pins and same-version artifact replacement', () => {
    const connector = installed[0]!;
    for (const artifactSha256 of [null, 'f'.repeat(64)]) {
      expect(() =>
        requirePinnedSandboxConnector(
          {
            artifactSha256,
            connectorId: connector.manifest.id,
            connectorVersion: connector.manifest.version,
          },
          installed
        )
      ).toThrow(/pinned artifact digest/);
    }
  });
});
