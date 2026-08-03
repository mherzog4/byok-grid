import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SESSION_EXPIRES_IN_SECONDS,
  DEFAULT_SESSION_UPDATE_AGE_SECONDS,
  resolveSessionPolicy,
} from './session-policy';

describe('session policy', () => {
  it('uses a hard seven-day expiry for public deployments', () => {
    expect(
      resolveSessionPolicy({ BETTER_AUTH_URL: 'https://grid.example.com' })
    ).toEqual({
      expiresInSeconds: DEFAULT_SESSION_EXPIRES_IN_SECONDS,
      refreshEnabled: false,
      updateAgeSeconds: DEFAULT_SESSION_UPDATE_AGE_SECONDS,
    });
  });

  it('retains sliding refresh for loopback evaluation', () => {
    expect(
      resolveSessionPolicy({ BETTER_AUTH_URL: 'http://localhost:3000' })
        .refreshEnabled
    ).toBe(true);
  });

  it('accepts an explicit bounded deployment policy', () => {
    expect(
      resolveSessionPolicy({
        BETTER_AUTH_URL: 'https://grid.example.com',
        BYOK_GRID_SESSION_EXPIRES_IN_SECONDS: '43200',
        BYOK_GRID_SESSION_REFRESH_ENABLED: 'true',
        BYOK_GRID_SESSION_UPDATE_AGE_SECONDS: '3600',
      })
    ).toEqual({
      expiresInSeconds: 43200,
      refreshEnabled: true,
      updateAgeSeconds: 3600,
    });
  });

  it('rejects ambiguous, excessive, or internally inconsistent values', () => {
    expect(() =>
      resolveSessionPolicy({
        BETTER_AUTH_URL: 'https://grid.example.com',
        BYOK_GRID_SESSION_REFRESH_ENABLED: 'yes',
      })
    ).toThrow('must be true or false');

    expect(() =>
      resolveSessionPolicy({
        BETTER_AUTH_URL: 'https://grid.example.com',
        BYOK_GRID_SESSION_EXPIRES_IN_SECONDS: '2592001',
      })
    ).toThrow('must be between 900 and 2592000 seconds');

    expect(() =>
      resolveSessionPolicy({
        BETTER_AUTH_URL: 'https://grid.example.com',
        BYOK_GRID_SESSION_EXPIRES_IN_SECONDS: '3600',
        BYOK_GRID_SESSION_UPDATE_AGE_SECONDS: '3600',
      })
    ).toThrow('must be less than');
  });
});
