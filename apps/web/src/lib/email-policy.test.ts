import { describe, expect, it } from 'vitest';
import { resolveEmailPolicy } from './email-policy';

describe('email policy', () => {
  it('fails closed with delivery disabled by default', () => {
    expect(resolveEmailPolicy({})).toEqual({ mode: 'disabled' });
  });

  it('accepts authenticated TLS SMTP configuration', () => {
    expect(
      resolveEmailPolicy({
        BYOK_GRID_EMAIL_MODE: 'smtp',
        SMTP_FROM_EMAIL: 'SECURITY@example.com',
        SMTP_FROM_NAME: 'BYOK Grid Security',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PASSWORD: 'secret-value',
        SMTP_PORT: '587',
        SMTP_REQUIRE_TLS: 'true',
        SMTP_SECURE: 'false',
        SMTP_USER: 'mailer',
      })
    ).toEqual({
      fromEmail: 'security@example.com',
      fromName: 'BYOK Grid Security',
      mode: 'smtp',
      smtp: {
        host: 'smtp.example.com',
        password: 'secret-value',
        port: 587,
        requireTls: true,
        secure: false,
        user: 'mailer',
      },
    });
  });

  it('permits unauthenticated cleartext SMTP only on loopback', () => {
    expect(
      resolveEmailPolicy({
        BYOK_GRID_EMAIL_MODE: 'smtp',
        SMTP_FROM_EMAIL: 'security@example.com',
        SMTP_HOST: '127.0.0.1',
        SMTP_REQUIRE_TLS: 'false',
      })
    ).toMatchObject({
      mode: 'smtp',
      smtp: { host: '127.0.0.1', requireTls: false },
    });

    expect(() =>
      resolveEmailPolicy({
        BYOK_GRID_EMAIL_MODE: 'smtp',
        SMTP_FROM_EMAIL: 'security@example.com',
        SMTP_HOST: 'smtp.example.com',
        SMTP_REQUIRE_TLS: 'false',
      })
    ).toThrow('may be false only');
  });

  it('rejects partial credentials and header injection without echoing secrets', () => {
    let error: unknown;
    try {
      resolveEmailPolicy({
        BYOK_GRID_EMAIL_MODE: 'smtp',
        SMTP_FROM_EMAIL: 'security@example.com\nBcc: attacker@example.com',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PASSWORD: 'do-not-echo-this-secret',
      });
    } catch (caught) {
      error = caught;
    }

    expect(String(error)).toContain('SMTP_FROM_EMAIL');
    expect(String(error)).toContain('must either both be set');
    expect(String(error)).not.toContain('do-not-echo-this-secret');
  });

  it('rejects unknown modes, invalid ports, and ambiguous booleans', () => {
    expect(() => resolveEmailPolicy({ BYOK_GRID_EMAIL_MODE: 'maybe' })).toThrow(
      'must be one of'
    );
    expect(() =>
      resolveEmailPolicy({
        BYOK_GRID_EMAIL_MODE: 'smtp',
        SMTP_FROM_EMAIL: 'security@example.com',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '0',
        SMTP_SECURE: 'yes',
      })
    ).toThrow('SMTP_PORT');
    expect(() =>
      resolveEmailPolicy({
        BYOK_GRID_EMAIL_MODE: 'smtp',
        SMTP_FROM_EMAIL: 'security@example.com',
        SMTP_HOST: 'smtp.example.com:587',
      })
    ).toThrow('without a scheme or path');
  });
});
