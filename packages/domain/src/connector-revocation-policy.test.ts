import { describe, expect, it } from 'vitest';
import {
  connectorExecutionIsRevoked,
  connectorRevocationTargetKey,
  matchingConnectorRevocations,
  type ActiveConnectorRevocation,
} from './connector-revocation-policy';

const identity = {
  artifactSha256: 'a'.repeat(64),
  connectorId: 'community_lookup',
  connectorVersion: '1.2.3',
  publisherKeyIds: ['publisher_old', 'publisher_new'],
} as const;

function revocations(
  ...targets: ActiveConnectorRevocation['target'][]
): ActiveConnectorRevocation[] {
  return targets.map((target, index) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    target,
  }));
}

describe('connector revocation policy', () => {
  it('creates stable target keys for unique active records', () => {
    expect(
      connectorRevocationTargetKey({
        connectorId: 'community_lookup',
        connectorVersion: '1.2.3',
        kind: 'version',
      })
    ).toBe('version:community_lookup@1.2.3');
  });

  it('lets artifact, version, and connector scopes override signatures', () => {
    for (const target of [
      { artifactSha256: 'a'.repeat(64), kind: 'artifact' },
      {
        connectorId: 'community_lookup',
        connectorVersion: '1.2.3',
        kind: 'version',
      },
      { connectorId: 'community_lookup', kind: 'connector' },
    ] as const) {
      expect(connectorExecutionIsRevoked(identity, revocations(target))).toBe(
        true
      );
    }
  });

  it('preserves dual-signature rotation until every signer is revoked', () => {
    const oldOnly = revocations({
      kind: 'publisher',
      publisherKeyId: 'publisher_old',
    });
    expect(connectorExecutionIsRevoked(identity, oldOnly)).toBe(false);

    const both = revocations(
      { kind: 'publisher', publisherKeyId: 'publisher_old' },
      { kind: 'publisher', publisherKeyId: 'publisher_new' }
    );
    expect(matchingConnectorRevocations(identity, both)).toHaveLength(2);
  });

  it('does not apply unrelated or publisher-only rules to built-ins', () => {
    expect(
      connectorExecutionIsRevoked(
        {
          artifactSha256: null,
          connectorId: 'hunter',
          connectorVersion: '1.0.0',
          publisherKeyIds: [],
        },
        revocations({
          kind: 'publisher',
          publisherKeyId: 'publisher_old',
        })
      )
    ).toBe(false);
  });
});
