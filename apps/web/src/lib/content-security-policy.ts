import { randomUUID } from 'node:crypto';

export function createContentSecurityPolicyNonce(): string {
  return Buffer.from(randomUUID()).toString('base64');
}

export function createContentSecurityPolicy(
  nonce: string,
  development = process.env.NODE_ENV === 'development'
): string {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(nonce)) {
    throw new Error('The Content Security Policy nonce must be base64.');
  }

  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}
