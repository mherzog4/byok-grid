import type { NextConfig } from 'next';
import { existsSync } from 'node:fs';
import path from 'node:path';

const repositoryRoot = path.join(__dirname, '../..');
const buildRoot = existsSync(path.join(repositoryRoot, 'package.json'))
  ? repositoryRoot
  : __dirname;

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
  outputFileTracingRoot: buildRoot,
  poweredByHeader: false,
  turbopack: {
    root: buildRoot,
  },
};

export default nextConfig;
