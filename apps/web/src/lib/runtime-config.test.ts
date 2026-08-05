import { describe, expect, it } from 'vitest';
import {
  assertWebRuntimeConfiguration,
  WebRuntimeConfigurationError,
} from './runtime-config';

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  BYOK_GRID_MASTER_KEY: 'Y2ktb25seS1ub3QtYS1wcm9kLWtleS0xMjM0NTY3ODk=',
  BYOK_GRID_MASTER_KEY_ID: 'test-v1',
  SQLITE_DATABASE_URL: 'file:./data/test.sqlite',
};

describe('web runtime configuration', () => {
  it('accepts a local single-user configuration without authentication', () => {
    expect(() => assertWebRuntimeConfiguration(validEnvironment)).not.toThrow();
  });

  it('accepts an optional public HTTPS origin and loopback HTTP', () => {
    for (const publicUrl of [
      'https://grid.example.com',
      'http://127.0.0.1:3000',
    ]) {
      expect(() =>
        assertWebRuntimeConfiguration({
          ...validEnvironment,
          BYOK_GRID_PUBLIC_URL: publicUrl,
        })
      ).not.toThrow();
    }
  });

  it('requires a canonical and secure public origin when configured', () => {
    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_PUBLIC_URL: 'http://grid.example.com',
      })
    ).toThrow('BYOK_GRID_PUBLIC_URL must use HTTPS');

    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_PUBLIC_URL: 'https://grid.example.com/a/subpath',
      })
    ).toThrow('BYOK_GRID_PUBLIC_URL must be an origin without a path.');
  });

  it('rejects malformed encryption keys without exposing their values', () => {
    let error: unknown;
    try {
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_MASTER_KEY: 'do-not-log-this-invalid-secret',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WebRuntimeConfigurationError);
    expect(String(error)).toContain('BYOK_GRID_MASTER_KEY');
    expect(String(error)).not.toContain('do-not-log-this-invalid-secret');
  });

  it('validates rotation-overlap keys without exposing their values', () => {
    const oldKey = Buffer.alloc(32, 9).toString('base64');
    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_ADDITIONAL_MASTER_KEYS: JSON.stringify({
          'old-v1': oldKey,
        }),
      })
    ).not.toThrow();

    const unsafeValue = '{"old-v1":"do-not-log-this-key"}';
    let error: unknown;
    try {
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_ADDITIONAL_MASTER_KEYS: unsafeValue,
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain('invalid master-key configuration');
    expect(String(error)).not.toContain(unsafeValue);
    expect(String(error)).not.toContain('do-not-log-this-key');
  });

  it('rejects missing and empty database locations', () => {
    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        SQLITE_DATABASE_URL: undefined,
      })
    ).toThrow('SQLITE_DATABASE_URL');

    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        SQLITE_DATABASE_URL: 'file:',
      })
    ).toThrow('SQLITE_DATABASE_URL must include a file path.');
  });

  it('requires libSQL when the deployment selects remote database mode', () => {
    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_DATABASE_MODE: 'remote',
      })
    ).toThrow('BYOK_GRID_DATABASE_MODE=remote requires libsql://');

    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_DATABASE_MODE: 'remote',
        SQLITE_DATABASE_URL: 'libsql://database.example.test',
      })
    ).not.toThrow();
  });
});
