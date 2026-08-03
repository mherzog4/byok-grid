import nodemailer from 'nodemailer';
import type Mail from 'nodemailer/lib/mailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool';
import type { EmailPolicy } from './email-policy';

export type AuthenticationEmailKind = 'password-reset' | 'verify-email';

export interface AuthenticationEmailDelivery {
  send(message: {
    kind: AuthenticationEmailKind;
    to: string;
    url: string;
  }): Promise<void>;
  verify(): Promise<void>;
}

interface MailTransport {
  sendMail(message: Mail.Options): Promise<unknown>;
  verify(): Promise<unknown>;
}

type MailTransportFactory = (options: SMTPPool.Options) => MailTransport;

export function createAuthenticationEmailDelivery(
  policy: EmailPolicy,
  baseUrl: string | undefined,
  createTransport: MailTransportFactory = (options) =>
    nodemailer.createTransport(options)
): AuthenticationEmailDelivery | undefined {
  if (policy.mode === 'disabled') return undefined;

  const origin = canonicalOrigin(baseUrl);
  const transport = createTransport(smtpTransportOptions(policy));

  return {
    async send(message) {
      assertAuthenticationLink(message.url, origin);
      const content = authenticationEmailContent(message.kind, message.url);
      await transport.sendMail({
        disableFileAccess: true,
        disableUrlAccess: true,
        from: { address: policy.fromEmail, name: policy.fromName },
        headers: { 'Auto-Submitted': 'auto-generated' },
        subject: content.subject,
        text: content.text,
        to: message.to,
      });
    },
    async verify() {
      await transport.verify();
    },
  };
}

export function smtpTransportOptions(
  policy: Extract<EmailPolicy, { mode: 'smtp' }>
): SMTPPool.Options {
  return {
    ...(policy.smtp.user && policy.smtp.password
      ? {
          auth: {
            pass: policy.smtp.password,
            user: policy.smtp.user,
          },
        }
      : {}),
    connectionTimeout: 10_000,
    debug: false,
    greetingTimeout: 10_000,
    host: policy.smtp.host,
    logger: false,
    maxConnections: 2,
    maxMessages: 50,
    pool: true,
    port: policy.smtp.port,
    requireTLS: policy.smtp.requireTls,
    secure: policy.smtp.secure,
    socketTimeout: 20_000,
    tls: {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
    },
  };
}

export function authenticationEmailContent(
  kind: AuthenticationEmailKind,
  url: string
): { subject: string; text: string } {
  if (kind === 'password-reset') {
    return {
      subject: 'Reset your BYOK Grid password',
      text: [
        'A password reset was requested for your BYOK Grid account.',
        '',
        `Reset your password: ${url}`,
        '',
        'This single-use link expires in one hour. If you did not request it, you can ignore this email.',
      ].join('\n'),
    };
  }
  return {
    subject: 'Verify your BYOK Grid email',
    text: [
      'Verify the email address for your BYOK Grid account.',
      '',
      `Verify your email: ${url}`,
      '',
      'This link expires in one hour. If you did not create this account, you can ignore this email.',
    ].join('\n'),
  };
}

function canonicalOrigin(value: string | undefined): string {
  if (!value) {
    throw new Error(
      'BETTER_AUTH_URL is required when email delivery is enabled.'
    );
  }
  return new URL(value).origin;
}

function assertAuthenticationLink(value: string, origin: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Authentication email link was not an absolute URL.');
  }
  if (url.origin !== origin || !url.pathname.startsWith('/api/auth/')) {
    throw new Error('Authentication email link escaped the configured origin.');
  }
}
