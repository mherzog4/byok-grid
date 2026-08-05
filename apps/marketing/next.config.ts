import type { NextConfig } from 'next';
import path from 'node:path';

const monorepoRoot = path.join(__dirname, '../..');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ headers: securityHeaders, source: '/(.*)' }];
  },
  outputFileTracingRoot: monorepoRoot,
  poweredByHeader: false,
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
