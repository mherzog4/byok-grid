import { z } from 'zod';
import {
  connectorIdentifierSchema,
  connectorVersionSchema,
  entityIdSchema,
} from './identifiers';

export const connectorArtifactDigestSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const connectorPublisherKeyIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const connectorRevocationTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('publisher'),
    publisherKeyId: connectorPublisherKeyIdSchema,
  }),
  z.strictObject({
    connectorId: connectorIdentifierSchema,
    kind: z.literal('connector'),
  }),
  z.strictObject({
    connectorId: connectorIdentifierSchema,
    connectorVersion: connectorVersionSchema,
    kind: z.literal('version'),
  }),
  z.strictObject({
    artifactSha256: connectorArtifactDigestSchema,
    kind: z.literal('artifact'),
  }),
]);

export type ConnectorRevocationTarget = z.infer<
  typeof connectorRevocationTargetSchema
>;

export const createConnectorRevocationRequestSchema = z.strictObject({
  reason: z.string().trim().min(8).max(500),
  target: connectorRevocationTargetSchema,
});

export const liftConnectorRevocationRequestSchema = z.strictObject({
  confirmationTargetKey: z.string().min(1).max(256),
});

export type ConnectorExecutionIdentity = Readonly<{
  artifactSha256: string | null;
  connectorId: string;
  connectorVersion: string;
  publisherKeyIds: readonly string[];
}>;

export type ActiveConnectorRevocation = Readonly<{
  id: string;
  target: ConnectorRevocationTarget;
}>;

export function connectorRevocationTargetKey(
  target: ConnectorRevocationTarget
): string {
  switch (target.kind) {
    case 'publisher':
      return `publisher:${target.publisherKeyId}`;
    case 'connector':
      return `connector:${target.connectorId}`;
    case 'version':
      return `version:${target.connectorId}@${target.connectorVersion}`;
    case 'artifact':
      return `artifact:${target.artifactSha256}`;
  }
}

export function matchingConnectorRevocations(
  identity: ConnectorExecutionIdentity,
  revocations: readonly ActiveConnectorRevocation[]
): readonly ActiveConnectorRevocation[] {
  const directMatches = revocations.filter(({ target }) => {
    switch (target.kind) {
      case 'connector':
        return target.connectorId === identity.connectorId;
      case 'version':
        return (
          target.connectorId === identity.connectorId &&
          target.connectorVersion === identity.connectorVersion
        );
      case 'artifact':
        return (
          identity.artifactSha256 !== null &&
          target.artifactSha256 === identity.artifactSha256
        );
      case 'publisher':
        return false;
    }
  });
  if (directMatches.length > 0) return directMatches;

  const publisherRevocations = new Map(
    revocations.flatMap((revocation) =>
      revocation.target.kind === 'publisher'
        ? [[revocation.target.publisherKeyId, revocation] as const]
        : []
    )
  );
  // TODO(product owner): decide whether one revoked co-signer should override
  // every other verified publisher instead of requiring all signers revoked.
  if (
    identity.publisherKeyIds.length > 0 &&
    identity.publisherKeyIds.every((keyId) => publisherRevocations.has(keyId))
  ) {
    return identity.publisherKeyIds.map((keyId) =>
      publisherRevocations.get(keyId)!
    );
  }
  return [];
}

export function connectorExecutionIsRevoked(
  identity: ConnectorExecutionIdentity,
  revocations: readonly ActiveConnectorRevocation[]
): boolean {
  return matchingConnectorRevocations(identity, revocations).length > 0;
}

export const connectorRevocationIdSchema = entityIdSchema;
