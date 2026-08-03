import { z } from 'zod';

/**
 * Validates non-secret endpoint configuration. Network reachability and
 * public-address enforcement still happen in the worker after DNS resolution.
 */
export function vaultSafeHttpsUrlSchema(subject: string) {
  return z.url().superRefine((value, context) => {
    if (!value.toLocaleLowerCase('en-US').startsWith('https://')) {
      context.addIssue({
        code: 'custom',
        message: `${subject} URLs must use HTTPS.`,
      });
    }
    const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/, 1)[0];
    if (authority?.includes('@')) {
      context.addIssue({
        code: 'custom',
        message: `${subject} credentials must use the BYOK vault, not the URL.`,
      });
    }
    if (value.includes('#')) {
      context.addIssue({
        code: 'custom',
        message: `${subject} URLs cannot contain fragments.`,
      });
    }
    if (hasSensitiveQueryParameter(value)) {
      context.addIssue({
        code: 'custom',
        message: `${subject} secrets must use the BYOK vault, not query parameters.`,
      });
    }
  });
}

function hasSensitiveQueryParameter(value: string): boolean {
  const queryStart = value.indexOf('?');
  if (queryStart < 0) return false;
  const query = value.slice(queryStart + 1).split('#', 1)[0] ?? '';
  const sensitiveNames = new Set([
    'apikey',
    'accesstoken',
    'key',
    'secret',
    'sig',
    'signature',
    'token',
  ]);
  return query.split('&').some((parameter) => {
    const rawName = parameter.split('=', 1)[0] ?? '';
    try {
      const normalized = decodeURIComponent(rawName)
        .replace(/[\s_-]/g, '')
        .toLocaleLowerCase('en-US');
      return sensitiveNames.has(normalized);
    } catch {
      return true;
    }
  });
}
