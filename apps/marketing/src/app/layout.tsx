import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { repositoryUrl, siteUrl } from '@/lib/site';
import './globals.css';

const description =
  'An open-source, SQLite-first enrichment grid with visual node workflows and provider keys you control.';

export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: {
    default: 'BYOK Grid — Own the data. Bring the keys.',
    template: '%s · BYOK Grid',
  },
  description,
  alternates: { canonical: '/' },
  category: 'technology',
  keywords: [
    'open source data enrichment',
    'BYOK',
    'workflow automation',
    'SQLite',
    'Next.js',
  ],
  openGraph: {
    description,
    images: [
      {
        alt: 'BYOK Grid open-source enrichment workspace',
        url: '/opengraph-image',
      },
    ],
    siteName: 'BYOK Grid',
    title: 'Own the data. Bring the keys. Build the workflow.',
    type: 'website',
    url: '/',
  },
  robots: {
    follow: true,
    index: true,
  },
  twitter: {
    card: 'summary_large_image',
    description,
    images: ['/opengraph-image'],
    title: 'BYOK Grid — Own the data. Bring the keys.',
  },
  other: {
    'source-code': repositoryUrl,
  },
};

export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0a0c0b',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
