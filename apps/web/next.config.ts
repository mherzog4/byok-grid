import type { NextConfig } from 'next';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';

const monorepoRoot = path.join(__dirname, '../..');
const rootEnvFile = path.join(monorepoRoot, '.env');
if (existsSync(rootEnvFile)) loadEnvFile(rootEnvFile);

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000',
          },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Permissions-Policy',
            value:
              'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
        ],
        source: '/(.*)',
      },
      {
        headers: [
          {
            key: 'Cache-Control',
            value: 'private, no-store, max-age=0',
          },
        ],
        source: '/invite/:path*',
      },
    ];
  },
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  poweredByHeader: false,
  transpilePackages: ['@byok-grid/db'],
  turbopack: {
    root: monorepoRoot,
  },
};

export default nextConfig;
