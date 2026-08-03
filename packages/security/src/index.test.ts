import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptCredential,
  decryptSourceCursor,
  encryptCredential,
  encryptSourceCursor,
  generateWorkspaceKey,
  parseMasterKey,
  unwrapWorkspaceKey,
} from './index';

describe('workspace envelope encryption', () => {
  it('round-trips a credential only with its authenticated identifiers', () => {
    const workspaceId = randomUUID();
    const credentialId = randomUUID();
    const masterKey = parseMasterKey(
      'test-v1',
      randomBytes(32).toString('base64')
    );
    const wrapped = generateWorkspaceKey(workspaceId, masterKey);
    const workspaceKey = unwrapWorkspaceKey(workspaceId, wrapped, masterKey);
    const encrypted = encryptCredential(
      workspaceId,
      credentialId,
      workspaceKey,
      {
        token: 'secret-token',
      }
    );

    expect(
      decryptCredential(workspaceId, credentialId, workspaceKey, encrypted)
    ).toEqual({ token: 'secret-token' });
    expect(encrypted.ciphertext).not.toContain('secret-token');
  });

  it('rejects moving ciphertext to another workspace or credential', () => {
    const workspaceId = randomUUID();
    const credentialId = randomUUID();
    const masterKey = parseMasterKey(
      'test-v1',
      randomBytes(32).toString('base64')
    );
    const wrapped = generateWorkspaceKey(workspaceId, masterKey);
    const workspaceKey = unwrapWorkspaceKey(workspaceId, wrapped, masterKey);
    const encrypted = encryptCredential(
      workspaceId,
      credentialId,
      workspaceKey,
      {
        token: 'secret-token',
      }
    );

    expect(() =>
      decryptCredential(randomUUID(), credentialId, workspaceKey, encrypted)
    ).toThrow();
    expect(() =>
      decryptCredential(workspaceId, randomUUID(), workspaceKey, encrypted)
    ).toThrow();
    expect(() =>
      unwrapWorkspaceKey(randomUUID(), wrapped, masterKey)
    ).toThrow();
  });

  it('rejects malformed master keys', () => {
    expect(() => parseMasterKey('test-v1', 'not-a-key')).toThrow(
      /exactly 32 bytes/
    );
  });

  it('encrypts pagination cursors with source-run-specific context', () => {
    const workspaceId = randomUUID();
    const sourceRunId = randomUUID();
    const masterKey = parseMasterKey(
      'test-v1',
      randomBytes(32).toString('base64')
    );
    const workspaceKey = unwrapWorkspaceKey(
      workspaceId,
      generateWorkspaceKey(workspaceId, masterKey),
      masterKey
    );
    const encrypted = encryptSourceCursor(
      workspaceId,
      sourceRunId,
      workspaceKey,
      'opaque-next-page'
    );
    expect(
      decryptSourceCursor(workspaceId, sourceRunId, workspaceKey, encrypted)
    ).toBe('opaque-next-page');
    expect(encrypted.ciphertext).not.toContain('opaque-next-page');
    expect(() =>
      decryptSourceCursor(workspaceId, randomUUID(), workspaceKey, encrypted)
    ).toThrow();
  });
});
