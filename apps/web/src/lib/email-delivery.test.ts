import { describe, expect, it, vi } from 'vitest';
import type Mail from 'nodemailer/lib/mailer';
import { createAuthenticationEmailDelivery } from './email-delivery';
import { resolveEmailPolicy } from './email-policy';

const smtpPolicy = resolveEmailPolicy({
  BYOK_GRID_EMAIL_MODE: 'smtp',
  SMTP_FROM_EMAIL: 'security@example.com',
  SMTP_FROM_NAME: 'BYOK Grid Security',
  SMTP_HOST: 'smtp.example.com',
  SMTP_PASSWORD: 'smtp-secret',
  SMTP_USER: 'mailer',
});

describe('authentication email delivery', () => {
  it('creates a bounded TLS transport and sends link-only recovery mail', async () => {
    const sendMail = vi.fn(async (message: Mail.Options) => {
      void message;
    });
    const verify = vi.fn(async () => true);
    const createTransport = vi.fn(() => ({ sendMail, verify }));
    const delivery = createAuthenticationEmailDelivery(
      smtpPolicy,
      'https://grid.example.com',
      createTransport
    );

    await delivery?.send({
      kind: 'password-reset',
      to: 'owner@example.com',
      url: 'https://grid.example.com/api/auth/reset-password/token?callbackURL=%2Freset-password',
    });
    await delivery?.verify();

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionTimeout: 10_000,
        host: 'smtp.example.com',
        pool: true,
        requireTLS: true,
        socketTimeout: 20_000,
        tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
      })
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        disableFileAccess: true,
        disableUrlAccess: true,
        from: {
          address: 'security@example.com',
          name: 'BYOK Grid Security',
        },
        headers: { 'Auto-Submitted': 'auto-generated' },
        subject: 'Reset your BYOK Grid password',
        to: 'owner@example.com',
      })
    );
    expect(String(sendMail.mock.calls[0]?.[0].text)).toContain(
      'This single-use link expires in one hour.'
    );
    expect(verify).toHaveBeenCalledOnce();
  });

  it('refuses links outside the canonical auth route without sending', async () => {
    const sendMail = vi.fn(async (message: Mail.Options) => {
      void message;
    });
    const delivery = createAuthenticationEmailDelivery(
      smtpPolicy,
      'https://grid.example.com',
      () => ({ sendMail, verify: async () => true })
    );

    await expect(
      delivery?.send({
        kind: 'verify-email',
        to: 'owner@example.com',
        url: 'https://attacker.example/reset?token=secret',
      })
    ).rejects.toThrow('escaped the configured origin');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('does not construct a transport when delivery is disabled', () => {
    const createTransport = vi.fn();
    expect(
      createAuthenticationEmailDelivery(
        { mode: 'disabled' },
        undefined,
        createTransport
      )
    ).toBeUndefined();
    expect(createTransport).not.toHaveBeenCalled();
  });
});
