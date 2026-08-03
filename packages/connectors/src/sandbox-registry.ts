import {
  connectorManifestSchema,
  type ConnectorManifest,
} from '@byok-grid/connector-sdk';
import { createPublicKey, verify } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { compileSandboxJsonSchema } from './sandbox-schema';

const artifactSchema = z.strictObject({
  path: z.string().min(1).max(4_096),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

const credentialFieldSchema = z.strictObject({
  description: z.string().min(1).max(512),
  key: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  label: z.string().min(1).max(120),
  placeholder: z.string().max(120).optional(),
  required: z.boolean(),
  secret: z.boolean(),
});

const credentialFormSchema = z.strictObject({
  fields: z.array(credentialFieldSchema).min(1).max(16),
});

const reservedConnectorIds = new Set([
  'http',
  'http_waterfall',
  'hubspot',
  'hunter',
  'openai',
  'webhook',
]);

const registrySchema = z.strictObject({
  connectors: z
    .array(
      z.strictObject({
        artifact: artifactSchema,
        catalog: z.boolean().default(true),
        credentialForm: credentialFormSchema.nullable().default(null),
        manifest: connectorManifestSchema,
      })
    )
    .max(256),
});

const signingKeyIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const publicKeyHexSchema = z.string().regex(/^[0-9a-f]{64}$/);
const signatureHexSchema = z.string().regex(/^[0-9a-f]{128}$/);
const registrySignatureFileSchema = z.strictObject({
  signatures: z
    .array(
      z.strictObject({
        keyId: signingKeyIdSchema,
        signature: signatureHexSchema,
      })
    )
    .min(1)
    .max(32),
  version: z.literal(1),
});
const trustedPublicKeysSchema = z
  .record(signingKeyIdSchema, publicKeyHexSchema)
  .refine(
    (keys) => Object.keys(keys).length <= 32,
    'At most 32 connector publisher keys can be trusted.'
  );

export const SANDBOX_REGISTRY_SIGNATURE_CONTEXT = Buffer.from(
  'BYOK_GRID_CONNECTOR_REGISTRY_V1\0',
  'utf8'
);

export interface SandboxRegistryTrustOptions {
  allowUnsigned: boolean;
  signaturePath?: string;
  trustedPublicKeys: Readonly<Record<string, string>>;
}

export type InstalledSandboxConnector = Readonly<{
  artifact: Readonly<{ path: string; sha256: string }>;
  catalog: boolean;
  credentialForm: Readonly<{
    fields: readonly Readonly<{
      description: string;
      key: string;
      label: string;
      placeholder?: string;
      required: boolean;
      secret: boolean;
    }>[];
  }> | null;
  manifest: ConnectorManifest;
  publisherKeyIds: readonly string[];
  registrySha256: string | null;
}>;

export interface InstalledSandboxConnectorSummary {
  actions: readonly Readonly<{
    hosts: readonly string[];
    id: string;
    name: string;
  }>[];
  artifactSha256: string;
  catalog: boolean;
  description: string;
  displayName: string;
  id: string;
  publisherKeyIds: readonly string[];
  registrySha256: string | null;
  version: string;
}

export function summarizeInstalledSandboxConnectors(
  connectors: readonly InstalledSandboxConnector[] = loadSandboxConnectorRegistry()
): readonly InstalledSandboxConnectorSummary[] {
  return connectors.map((connector) => ({
    actions: connector.manifest.actions.map((action) => ({
      hosts:
        action.hostPolicy.kind === 'fixed' ? [...action.hostPolicy.hosts] : [],
      id: action.id,
      name: action.name,
    })),
    artifactSha256: connector.artifact.sha256,
    catalog: connector.catalog,
    description: connector.manifest.description,
    displayName: connector.manifest.displayName,
    id: connector.manifest.id,
    publisherKeyIds: connector.publisherKeyIds,
    registrySha256: connector.registrySha256,
    version: connector.manifest.version,
  }));
}

export function parseSandboxConnectorRegistry(
  value: unknown,
  builtInIds: ReadonlySet<string> = reservedConnectorIds
): readonly InstalledSandboxConnector[] {
  const registry = registrySchema.parse(value);
  const identities = new Set<string>();
  const catalogIds = new Set<string>();
  for (const connector of registry.connectors) {
    const { manifest } = connector;
    if (builtInIds.has(manifest.id)) {
      throw new TypeError(
        `Sandbox connector ${manifest.id} collides with a built-in connector.`
      );
    }
    const identity = `${manifest.id}@${manifest.version}`;
    if (identities.has(identity)) {
      throw new TypeError(`Sandbox connector ${identity} is repeated.`);
    }
    identities.add(identity);
    if (connector.catalog && catalogIds.has(manifest.id)) {
      throw new TypeError(
        `Sandbox connector ${manifest.id} has more than one catalog version.`
      );
    }
    if (connector.catalog) catalogIds.add(manifest.id);
    if (manifest.actions.some((action) => action.hostPolicy.kind !== 'fixed')) {
      throw new TypeError(
        `Sandbox connector ${identity} must declare fixed egress hosts.`
      );
    }
    validateCredentialForm(connector, identity);
    compileSandboxJsonSchema(manifest.credentialSchema);
    const actionIds = new Set<string>();
    for (const action of manifest.actions) {
      if (actionIds.has(action.id)) {
        throw new TypeError(
          `Sandbox connector ${identity} repeats action ${action.id}.`
        );
      }
      actionIds.add(action.id);
      const fieldKeys = new Set<string>();
      for (const field of action.inputFields) {
        if (fieldKeys.has(field.key)) {
          throw new TypeError(
            `Sandbox connector ${identity}.${action.id} repeats input ${field.key}.`
          );
        }
        fieldKeys.add(field.key);
      }
      compileSandboxJsonSchema(action.inputSchema);
      compileSandboxJsonSchema(action.outputSchema);
    }
  }
  return registry.connectors.map((connector) => ({
    ...connector,
    publisherKeyIds: [],
    registrySha256: null,
  })) as unknown as readonly InstalledSandboxConnector[];
}

function validateCredentialForm(
  connector: z.infer<typeof registrySchema>['connectors'][number],
  identity: string
): void {
  const { credentialForm, manifest } = connector;
  if (manifest.credentialRequired !== Boolean(credentialForm)) {
    throw new TypeError(
      `Sandbox connector ${identity} credential form does not match credentialRequired.`
    );
  }
  if (!credentialForm) return;
  const properties = manifest.credentialSchema.properties;
  const required = manifest.credentialSchema.required;
  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties) ||
    manifest.credentialSchema.type !== 'object' ||
    manifest.credentialSchema.additionalProperties !== false ||
    !Array.isArray(required) ||
    required.some((key) => typeof key !== 'string')
  ) {
    throw new TypeError(
      `Sandbox connector ${identity} must use a closed object credential schema.`
    );
  }
  const schemaKeys = new Set(Object.keys(properties));
  const propertySchemas = properties as Record<string, unknown>;
  const requiredKeys = new Set(required as string[]);
  const fieldKeys = new Set<string>();
  for (const field of credentialForm.fields) {
    const propertySchema = propertySchemas[field.key];
    if (
      fieldKeys.has(field.key) ||
      !schemaKeys.has(field.key) ||
      field.required !== requiredKeys.has(field.key) ||
      !propertySchema ||
      typeof propertySchema !== 'object' ||
      Array.isArray(propertySchema) ||
      (propertySchema as Record<string, unknown>).type !== 'string'
    ) {
      throw new TypeError(
        `Sandbox connector ${identity} has an invalid credential field ${field.key}.`
      );
    }
    fieldKeys.add(field.key);
  }
  if (
    schemaKeys.size !== fieldKeys.size ||
    [...schemaKeys].some((key) => !fieldKeys.has(key))
  ) {
    throw new TypeError(
      `Sandbox connector ${identity} credential form must cover every property.`
    );
  }
}

export function loadSandboxConnectorRegistry(
  registryPath = process.env.BYOK_GRID_CONNECTOR_REGISTRY_PATH,
  trustOptions = sandboxRegistryTrustOptionsFromEnvironment()
): readonly InstalledSandboxConnector[] {
  if (!registryPath) return [];
  const absolutePath = resolve(/* turbopackIgnore: true */ registryPath);
  const normalizedTrust = normalizeTrustOptions(trustOptions);
  const cacheKey = JSON.stringify([
    absolutePath,
    normalizedTrust.allowUnsigned,
    resolve(
      /* turbopackIgnore: true */ normalizedTrust.signaturePath ??
        `${absolutePath}.sig.json`
    ),
    Object.entries(normalizedTrust.trustedPublicKeys).sort(([left], [right]) =>
      left.localeCompare(right)
    ),
  ]);
  const cached = registryCache.get(cacheKey);
  if (cached) return cached;
  const raw = readFileSync(/* turbopackIgnore: true */ absolutePath);
  const publisherKeyIds = verifySandboxConnectorRegistrySignature(
    raw,
    normalizedTrust,
    absolutePath
  );
  const registrySha256 = createHash('sha256').update(raw).digest('hex');
  const registry = parseSandboxConnectorRegistry(
    JSON.parse(raw.toString('utf8'))
  ).map((connector) => ({
    ...connector,
    publisherKeyIds,
    registrySha256,
  }));
  registryCache.set(cacheKey, registry);
  return registry;
}

export function sandboxRegistryTrustOptionsFromEnvironment(): SandboxRegistryTrustOptions {
  const allowUnsignedRaw =
    process.env.BYOK_GRID_ALLOW_UNSIGNED_CONNECTOR_REGISTRY;
  if (
    allowUnsignedRaw !== undefined &&
    allowUnsignedRaw !== 'true' &&
    allowUnsignedRaw !== 'false'
  ) {
    throw new TypeError(
      'BYOK_GRID_ALLOW_UNSIGNED_CONNECTOR_REGISTRY must be true or false.'
    );
  }
  let trustedPublicKeys: unknown = {};
  const rawKeys = process.env.BYOK_GRID_CONNECTOR_TRUST_KEYS;
  if (rawKeys) {
    try {
      trustedPublicKeys = JSON.parse(rawKeys);
    } catch {
      throw new TypeError('BYOK_GRID_CONNECTOR_TRUST_KEYS is invalid JSON.');
    }
  }
  const signaturePath = process.env.BYOK_GRID_CONNECTOR_REGISTRY_SIGNATURE_PATH;
  return normalizeTrustOptions({
    allowUnsigned: allowUnsignedRaw === 'true',
    ...(signaturePath ? { signaturePath } : {}),
    trustedPublicKeys: trustedPublicKeys as Record<string, string>,
  });
}

export function verifySandboxConnectorRegistrySignature(
  registryBytes: Uint8Array,
  rawTrustOptions: SandboxRegistryTrustOptions,
  registryPath = 'connector registry'
): readonly string[] {
  const trustOptions = normalizeTrustOptions(rawTrustOptions);
  const trustedEntries = Object.entries(trustOptions.trustedPublicKeys);
  if (trustedEntries.length === 0) {
    if (trustOptions.allowUnsigned) return [];
    throw new TypeError(
      'A connector registry requires at least one trusted publisher key.'
    );
  }
  const signaturePath = resolve(
    /* turbopackIgnore: true */ trustOptions.signaturePath ??
      `${registryPath}.sig.json`
  );
  let signatureFile: z.infer<typeof registrySignatureFileSchema>;
  try {
    signatureFile = registrySignatureFileSchema.parse(
      JSON.parse(
        readFileSync(/* turbopackIgnore: true */ signaturePath, 'utf8')
      )
    );
  } catch {
    throw new TypeError('The connector registry signature file is invalid.');
  }
  if (
    new Set(signatureFile.signatures.map((item) => item.keyId)).size !==
    signatureFile.signatures.length
  ) {
    throw new TypeError('The connector registry repeats a signature key ID.');
  }
  const signedBytes = Buffer.concat([
    SANDBOX_REGISTRY_SIGNATURE_CONTEXT,
    registryBytes,
  ]);
  const validPublisherKeyIds = signatureFile.signatures.flatMap((item) => {
    const publicKeyHex = trustOptions.trustedPublicKeys[item.keyId];
    if (!publicKeyHex) return [];
    try {
      const publicKey = createPublicKey({
        format: 'jwk',
        key: {
          crv: 'Ed25519',
          kty: 'OKP',
          x: Buffer.from(publicKeyHex, 'hex').toString('base64url'),
        },
      });
      return verify(
        null,
        signedBytes,
        publicKey,
        Buffer.from(item.signature, 'hex')
      )
        ? [item.keyId]
        : [];
    } catch {
      return [];
    }
  });
  if (validPublisherKeyIds.length === 0) {
    throw new TypeError(
      'The connector registry has no valid signature from a trusted publisher.'
    );
  }
  return validPublisherKeyIds.sort();
}

function normalizeTrustOptions(
  options: SandboxRegistryTrustOptions
): SandboxRegistryTrustOptions {
  return {
    allowUnsigned: options.allowUnsigned,
    ...(options.signaturePath ? { signaturePath: options.signaturePath } : {}),
    trustedPublicKeys: trustedPublicKeysSchema.parse(options.trustedPublicKeys),
  };
}

const registryCache = new Map<string, readonly InstalledSandboxConnector[]>();
