import { describe, expect, it } from 'vitest';
import nextConfig from '../next.config';

describe('Next.js public response headers', () => {
  it('does not advertise the application framework', () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it('keeps the global production security-header contract', async () => {
    expect(nextConfig.headers).toBeTypeOf('function');
    const rules = await nextConfig.headers!();
    const globalRule = rules.find((rule) => rule.source === '/(.*)');
    const headers = new Map(
      globalRule?.headers.map(({ key, value }) => [key, value])
    );

    expect(headers.has('Content-Security-Policy')).toBe(false);
    expect(headers.get('Strict-Transport-Security')).toBe('max-age=31536000');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(headers.get('Permissions-Policy')).toBe(
      'camera=(), microphone=(), geolocation=(), browsing-topics=()'
    );
  });

  it('keeps invitation pages private and non-cacheable', async () => {
    const rules = await nextConfig.headers!();
    const inviteRule = rules.find((rule) => rule.source === '/invite/:path*');
    expect(inviteRule?.headers).toContainEqual({
      key: 'Cache-Control',
      value: 'private, no-store, max-age=0',
    });
  });
});
