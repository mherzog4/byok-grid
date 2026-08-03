import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;

export const cryptoEnvelopeSchema = z.object({
  algorithm: z.literal('A256GCM'),
  ciphertext: z.string().min(1),
  keyId: z.string().min(1),
  nonce: z.string().min(1),
  tag: z.string().min(1),
  version: z.literal(1),
});

export type CryptoEnvelope = z.infer<typeof cryptoEnvelopeSchema>;

export type MasterKey = Readonly<{
  id: string;
  value: Buffer;
}>;

export function parseMasterKey(id: string, encoded: string): MasterKey {
  if (!id.trim()) {
    throw new Error('The master key ID must not be empty.');
  }

  const value = Buffer.from(encoded, 'base64');
  if (value.length !== KEY_BYTES || value.toString('base64') !== encoded) {
    throw new Error(
      'The master key must be exactly 32 bytes of canonical base64.'
    );
  }

  return { id, value };
}

export function generateWorkspaceKey(
  workspaceId: string,
  masterKey: MasterKey
): CryptoEnvelope {
  return seal(
    masterKey.value,
    randomBytes(KEY_BYTES),
    workspaceKeyContext(workspaceId),
    masterKey.id
  );
}

export function unwrapWorkspaceKey(
  workspaceId: string,
  wrappedKey: CryptoEnvelope,
  masterKey: MasterKey
): Buffer {
  if (wrappedKey.keyId !== masterKey.id) {
    throw new Error(`Master key ${wrappedKey.keyId} is not available.`);
  }

  const key = open(
    masterKey.value,
    wrappedKey,
    workspaceKeyContext(workspaceId)
  );
  if (key.length !== KEY_BYTES) {
    throw new Error('The unwrapped workspace key has an invalid length.');
  }
  return key;
}

export function encryptCredential(
  workspaceId: string,
  credentialId: string,
  workspaceKey: Buffer,
  value: Readonly<Record<string, unknown>>
): CryptoEnvelope {
  assertWorkspaceKey(workspaceKey);
  return seal(
    workspaceKey,
    Buffer.from(JSON.stringify(value), 'utf8'),
    credentialContext(workspaceId, credentialId),
    `workspace:${workspaceId}`
  );
}

export function decryptCredential(
  workspaceId: string,
  credentialId: string,
  workspaceKey: Buffer,
  envelope: CryptoEnvelope
): Readonly<Record<string, unknown>> {
  assertWorkspaceKey(workspaceKey);
  const plaintext = open(
    workspaceKey,
    envelope,
    credentialContext(workspaceId, credentialId)
  );
  const parsed: unknown = JSON.parse(plaintext.toString('utf8'));
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Decrypted credentials must be a JSON object.');
  }
  return parsed as Readonly<Record<string, unknown>>;
}

export function encryptSourceCursor(
  workspaceId: string,
  sourceRunId: string,
  workspaceKey: Buffer,
  cursor: string
): CryptoEnvelope {
  assertWorkspaceKey(workspaceKey);
  if (!cursor || cursor.length > 1_024 || /\p{Cc}/u.test(cursor)) {
    throw new Error('The source cursor is invalid or too large.');
  }
  return seal(
    workspaceKey,
    Buffer.from(cursor, 'utf8'),
    sourceCursorContext(workspaceId, sourceRunId),
    `workspace:${workspaceId}`
  );
}

export function decryptSourceCursor(
  workspaceId: string,
  sourceRunId: string,
  workspaceKey: Buffer,
  envelope: CryptoEnvelope
): string {
  assertWorkspaceKey(workspaceKey);
  return open(
    workspaceKey,
    envelope,
    sourceCursorContext(workspaceId, sourceRunId)
  ).toString('utf8');
}

function assertWorkspaceKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new Error('A workspace key must be exactly 32 bytes.');
  }
}

function workspaceKeyContext(workspaceId: string): string {
  return `byok-grid:v1:workspace:${workspaceId}:data-key`;
}

function credentialContext(workspaceId: string, credentialId: string): string {
  return `byok-grid:v1:workspace:${workspaceId}:credential:${credentialId}`;
}

function sourceCursorContext(workspaceId: string, sourceRunId: string): string {
  return `byok-grid:v1:workspace:${workspaceId}:source-run:${sourceRunId}:cursor`;
}

function seal(
  key: Buffer,
  plaintext: Buffer,
  context: string,
  keyId: string
): CryptoEnvelope {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    algorithm: 'A256GCM',
    ciphertext: ciphertext.toString('base64'),
    keyId,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    version: 1,
  };
}

function open(
  key: Buffer,
  rawEnvelope: CryptoEnvelope,
  context: string
): Buffer {
  const envelope = cryptoEnvelopeSchema.parse(rawEnvelope);
  const nonce = Buffer.from(envelope.nonce, 'base64');
  if (nonce.length !== NONCE_BYTES) {
    throw new Error('The encrypted value has an invalid nonce.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]);
}
