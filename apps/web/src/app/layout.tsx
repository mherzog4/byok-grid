import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import '@xyflow/react/dist/style.css';

export const metadata: Metadata = {
  description: 'Open-source, BYOK data enrichment workflows.',
  title: 'BYOK Grid',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
