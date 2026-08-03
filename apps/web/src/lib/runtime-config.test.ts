import { describe, expect, it } from 'vitest';
import {
  assertWebRuntimeConfiguration,
  WebRuntimeConfigurationError,
} from './runtime-config';

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  BETTER_AUTH_SECRET: 'test-only-auth-secret-with-32-characters',
  BETTER_AUTH_URL: 'https://grid.example.com',
  BYOK_GRID_MASTER_KEY: 'Y2ktb25seS1ub3QtYS1wcm9kLWtleS0xMjM0NTY3ODk=',
  BYOK_GRID_MASTER_KEY_ID: 'test-v1',
  SQLITE_DATABASE_URL: 'file:./data/test.sqlite',
};

describe('web runtime configuration', () => {
  it('accepts a valid public HTTPS configuration', () => {
    expect(() => assertWebRuntimeConfiguration(validEnvironment)).not.toThrow();
  });

  it('supports allowlisted public provisioning and rejects public open signup', () => {
    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_SIGNUP_ALLOWED_EMAILS: 'owner@example.com',
        BYOK_GRID_SIGNUP_MODE: 'allowlist',
      })
    ).not.toThrow();

    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BYOK_GRID_SIGNUP_MODE: 'open',
      })
    ).toThrow('open is allowed only for loopback');
  });

  it('allows HTTP only for loopback evaluation', () => {
    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BETTER_AUTH_URL: 'http://127.0.0.1:3000',
      })
    ).not.toThrow();

    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BETTER_AUTH_URL: 'http://grid.example.com',
      })
    ).toThrow('BETTER_AUTH_URL must use HTTPS unless it targets loopback.');
  });

  it('requires the public auth URL to be a canonical origin', () => {
    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BETTER_AUTH_URL: 'https://grid.example.com/a/subpath',
      })
    ).toThrow('BETTER_AUTH_URL must be an origin without a path.');

    expect(() =>
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BETTER_AUTH_URL: 'https://grid.example.com/',
      })
    ).not.toThrow();
  });

  it('rejects weak auth secrets and malformed encryption keys safely', () => {
    let error: unknown;
    try {
      assertWebRuntimeConfiguration({
        ...validEnvironment,
        BETTER_AUTH_SECRET: 'too-short',
        BYOK_GRID_MASTER_KEY: 'do-not-log-this-invalid-secret',
      });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(WebRuntimeConfigurationError);
    expect(String(error)).toContain('BETTER_AUTH_SECRET');
    expect(String(error)).toContain('BYOK_GRID_MASTER_KEY');
    expect(String(error)).not.toContain('do-not-log-this-invalid-secret');
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
});
