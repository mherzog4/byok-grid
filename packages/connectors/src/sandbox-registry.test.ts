import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SANDBOX_REGISTRY_SIGNATURE_CONTEXT,
  loadSandboxConnectorRegistry,
  parseSandboxConnectorRegistry,
  verifySandboxConnectorRegistrySignature,
} from './sandbox-registry';

const REFERENCE_TRUST_KEYS = {
  byok_grid_reference_2026:
    'd30d04cc80d66bff277650ce03561ed543a321921199f48de5c20355bb213e86',
} as const;

const manifest = {
  actions: [
    {
      cellOutput: { path: ['runtime'], valueType: 'text' },
      description: 'Run an isolated check.',
      hostPolicy: { hosts: ['api.example.com'], kind: 'fixed' },
      id: 'lookup',
      inputFields: [
        {
          description: 'Domain to inspect.',
          key: 'domain',
          label: 'Domain',
          required: true,
          source: 'column',
        },
      ],
      inputSchema: { type: 'object' },
      name: 'Lookup',
      outputSchema: { type: 'object' },
    },
  ],
  category: 'data',
  credentialName: 'API secret',
  credentialRequired: true,
  credentialSchema: {
    additionalProperties: false,
    properties: { api_key: { minLength: 8, type: 'string' } },
    required: ['api_key'],
    type: 'object',
  },
  description: 'An isolated connector.',
  displayName: 'Community lookup',
  documentationUrl: 'https://example.com/docs',
  id: 'community_lookup',
  protocolVersion: '1.1',
  version: '1.0.0',
} as const;

const credentialForm = {
  fields: [
    {
      description: 'Workspace-owned provider API key.',
      key: 'api_key',
      label: 'API key',
      placeholder: 'provider_…',
      required: true,
      secret: true,
    },
  ],
} as const;

describe('sandbox connector registry', () => {
  it('accepts fixed-host, digest-pinned connectors', () => {
    const result = parseSandboxConnectorRegistry({
      connectors: [
        {
          artifact: { path: './lookup.wasm', sha256: 'a'.repeat(64) },
          credentialForm,
          manifest,
        },
      ],
    });
    expect(result[0]?.manifest.id).toBe('community_lookup');
  });

  it('loads the documented reference registry with bounded schemas', () => {
    const registry = loadSandboxConnectorRegistry(
      resolve(
        import.meta.dirname,
        '../../../examples/connectors/reference/registry.json'
      ),
      { allowUnsigned: false, trustedPublicKeys: REFERENCE_TRUST_KEYS }
    );
    expect(registry).toMatchObject([
      {
        credentialForm: null,
        manifest: { id: 'community_reference', version: '1.0.0' },
        publisherKeyIds: ['byok_grid_reference_2026'],
        registrySha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    ]);
  });

  it('authenticates exact registry bytes and rejects tampering', () => {
    const directory = mkdtempSync(
      resolve(tmpdir(), 'byok-grid-registry-signature-')
    );
    try {
      const signaturePath = resolve(directory, 'registry.json.sig.json');
      const registryBytes = Buffer.from('{"connectors":[]}\n');
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const publicJwk = publicKey.export({ format: 'jwk' });
      if (!publicJwk.x) throw new TypeError('Missing Ed25519 public key.');
      const signature = sign(
        null,
        Buffer.concat([SANDBOX_REGISTRY_SIGNATURE_CONTEXT, registryBytes]),
        privateKey
      ).toString('hex');
      writeFileSync(
        signaturePath,
        JSON.stringify({
          signatures: [{ keyId: 'test_publisher', signature }],
          version: 1,
        })
      );
      const trust = {
        allowUnsigned: false,
        signaturePath,
        trustedPublicKeys: {
          test_publisher: Buffer.from(publicJwk.x, 'base64url').toString('hex'),
        },
      } as const;

      expect(
        verifySandboxConnectorRegistrySignature(registryBytes, trust)
      ).toEqual(['test_publisher']);
      expect(() =>
        verifySandboxConnectorRegistrySignature(
          Buffer.from('{"connectors":[ ]}\n'),
          trust
        )
      ).toThrow(/no valid signature/);
      expect(() =>
        verifySandboxConnectorRegistrySignature(registryBytes, {
          ...trust,
          trustedPublicKeys: {
            unknown_publisher: trust.trustedPublicKeys.test_publisher,
          },
        })
      ).toThrow(/no valid signature/);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('requires publisher trust unless unsigned development mode is explicit', () => {
    expect(() =>
      verifySandboxConnectorRegistrySignature(Buffer.from('{}'), {
        allowUnsigned: false,
        trustedPublicKeys: {},
      })
    ).toThrow(/at least one trusted publisher key/);
    expect(() =>
      verifySandboxConnectorRegistrySignature(Buffer.from('{}'), {
        allowUnsigned: true,
        trustedPublicKeys: {},
      })
    ).not.toThrow();
  });

  it('rejects built-in collisions and runtime host policies', () => {
    expect(() =>
      parseSandboxConnectorRegistry(
        {
          connectors: [
            {
              artifact: { path: './lookup.wasm', sha256: 'a'.repeat(64) },
              credentialForm,
              manifest: { ...manifest, id: 'hunter' },
            },
          ],
        },
        new Set(['hunter'])
      )
    ).toThrow(/collides/);

    expect(() =>
      parseSandboxConnectorRegistry({
        connectors: [
          {
            artifact: { path: './lookup.wasm', sha256: 'a'.repeat(64) },
            credentialForm,
            manifest: {
              ...manifest,
              actions: [
                { ...manifest.actions[0], hostPolicy: { kind: 'runtime' } },
              ],
            },
          },
        ],
      })
    ).toThrow(/fixed egress hosts/);
  });
});
