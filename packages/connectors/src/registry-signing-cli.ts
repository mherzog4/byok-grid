import {
  createPrivateKey,
  generateKeyPairSync,
  sign as signBytes,
} from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { formatRegistryPublisherFingerprint } from './registry-signing-policy';
import { SANDBOX_REGISTRY_SIGNATURE_CONTEXT } from './sandbox-registry';

const keyIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const privateJwkSchema = z.strictObject({
  crv: z.literal('Ed25519'),
  d: z.string().min(1),
  kty: z.literal('OKP'),
  x: z.string().min(1),
});
const signatureFileSchema = z.strictObject({
  signatures: z.array(
    z.strictObject({
      keyId: keyIdSchema,
      signature: z.string().regex(/^[0-9a-f]{128}$/),
    })
  ),
  version: z.literal(1),
});

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'keygen') {
    generateSigningKey(args);
    return;
  }
  if (command === 'sign') {
    signRegistry(args);
    return;
  }
  throw new TypeError(
    'Usage: keygen <key-id> <private-jwk-path> <trust-json-path> | sign <key-id> <private-jwk-path> <registry-path> [signature-path]'
  );
}

function generateSigningKey(args: string[]): void {
  if (args.length !== 3) {
    throw new TypeError(
      'keygen requires a key ID, private JWK path, and public trust JSON path.'
    );
  }
  const [rawKeyId, rawPrivatePath, rawTrustPath] = args as [
    string,
    string,
    string,
  ];
  const keyId = keyIdSchema.parse(rawKeyId);
  const privatePath = resolve(rawPrivatePath);
  const trustPath = resolve(rawTrustPath);
  if (privatePath === trustPath) {
    throw new TypeError(
      'Private and public key outputs must be different files.'
    );
  }
  if (existsSync(privatePath) || existsSync(trustPath)) {
    throw new TypeError('Key generation refuses to overwrite an output file.');
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privateJwk = privateJwkSchema.parse(
    privateKey.export({ format: 'jwk' })
  );
  const publicJwk = publicKey.export({ format: 'jwk' });
  if (publicJwk.crv !== 'Ed25519' || publicJwk.kty !== 'OKP' || !publicJwk.x) {
    throw new TypeError('Node.js returned an invalid Ed25519 public key.');
  }
  const publicKeyHex = Buffer.from(publicJwk.x, 'base64url').toString('hex');
  writeFileSync(privatePath, `${JSON.stringify(privateJwk, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  writeFileSync(
    trustPath,
    `${JSON.stringify({ [keyId]: publicKeyHex }, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 }
  );
  process.stdout.write(
    `Generated ${keyId}; protect ${privatePath} and distribute ${trustPath}.\nPublic-key fingerprint: ${formatRegistryPublisherFingerprint(publicKeyHex)}\n`
  );
}

function signRegistry(args: string[]): void {
  if (args.length < 3 || args.length > 4) {
    throw new TypeError(
      'sign requires a key ID, private JWK path, registry path, and optional signature path.'
    );
  }
  const [rawKeyId, rawPrivatePath, rawRegistryPath, rawSignaturePath] =
    args as [string, string, string, string | undefined];
  const keyId = keyIdSchema.parse(rawKeyId);
  const privateJwk = privateJwkSchema.parse(
    JSON.parse(readFileSync(resolve(rawPrivatePath), 'utf8'))
  );
  const registryPath = resolve(rawRegistryPath);
  const signaturePath = resolve(rawSignaturePath ?? `${registryPath}.sig.json`);
  const registryBytes = readFileSync(registryPath);
  const signature = signBytes(
    null,
    Buffer.concat([SANDBOX_REGISTRY_SIGNATURE_CONTEXT, registryBytes]),
    createPrivateKey({ format: 'jwk', key: privateJwk })
  ).toString('hex');
  const existing = existsSync(signaturePath)
    ? signatureFileSchema.parse(JSON.parse(readFileSync(signaturePath, 'utf8')))
    : { signatures: [], version: 1 as const };
  const signatures = [
    ...existing.signatures.filter((item) => item.keyId !== keyId),
    { keyId, signature },
  ].sort((left, right) => left.keyId.localeCompare(right.keyId));
  if (signatures.length > 32) {
    throw new TypeError('A registry cannot contain more than 32 signatures.');
  }
  writeFileSync(
    signaturePath,
    `${JSON.stringify({ signatures, version: 1 }, null, 2)}\n`,
    { mode: 0o644 }
  );
  process.stdout.write(`Signed ${registryPath} as ${keyId}.\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Registry signing failed.'}\n`
  );
  process.exitCode = 1;
}
