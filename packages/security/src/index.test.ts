import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptCredential,
  decryptSourceCursor,
  encryptCredential,
  encryptSourceCursor,
  generateWorkspaceKey,
  parseMasterKey,
  parseMasterKeyRing,
  rewrapWorkspaceKey,
  unwrapWorkspaceKey,
  unwrapWorkspaceKeyFromRing,
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
    expect(() =>
      parseMasterKey('unsafe\nkey', randomBytes(32).toString('base64'))
    ).toThrow(/non-control/);
  });

  it('reads an old workspace key during a bounded rotation overlap', () => {
    const workspaceId = randomUUID();
    const oldEncoded = randomBytes(32).toString('base64');
    const currentEncoded = randomBytes(32).toString('base64');
    const oldKey = parseMasterKey('old-v1', oldEncoded);
    const masterKeys = parseMasterKeyRing(
      'current-v2',
      currentEncoded,
      JSON.stringify({ 'old-v1': oldEncoded })
    );
    const wrapped = generateWorkspaceKey(workspaceId, oldKey);

    const workspaceKey = unwrapWorkspaceKeyFromRing(
      workspaceId,
      wrapped,
      masterKeys
    );
    const rewrapped = rewrapWorkspaceKey(workspaceId, wrapped, masterKeys);
    const rewrappedWorkspaceKey = unwrapWorkspaceKey(
      workspaceId,
      rewrapped,
      masterKeys.current
    );

    expect(rewrapped.keyId).toBe('current-v2');
    expect(rewrappedWorkspaceKey).toEqual(workspaceKey);
    workspaceKey.fill(0);
    rewrappedWorkspaceKey.fill(0);
  });

  it('rejects ambiguous, excessive, and unavailable keyring entries', () => {
    const currentEncoded = randomBytes(32).toString('base64');
    expect(() =>
      parseMasterKeyRing(
        'current-v2',
        currentEncoded,
        JSON.stringify({ 'current-v2': currentEncoded })
      )
    ).toThrow(/must not be repeated/);
    expect(() =>
      parseMasterKeyRing(
        'current-v2',
        currentEncoded,
        JSON.stringify({ 'old-alias': currentEncoded })
      )
    ).toThrow(/must not be assigned to multiple IDs/);
    expect(() =>
      parseMasterKeyRing(
        'current-v2',
        currentEncoded,
        JSON.stringify(
          Object.fromEntries(
            Array.from({ length: 9 }, (_, index) => [
              `old-${index}`,
              randomBytes(32).toString('base64'),
            ])
          )
        )
      )
    ).toThrow(/At most 8/);

    const workspaceId = randomUUID();
    const unavailable = generateWorkspaceKey(
      workspaceId,
      parseMasterKey('missing-v1', randomBytes(32).toString('base64'))
    );
    expect(() =>
      unwrapWorkspaceKeyFromRing(
        workspaceId,
        unavailable,
        parseMasterKeyRing('current-v2', currentEncoded)
      )
    ).toThrow('The required master key is not available.');
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
