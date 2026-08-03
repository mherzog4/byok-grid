import type { Metadata } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';
import './globals.css';
import '@xyflow/react/dist/style.css';

export const metadata: Metadata = {
  description: 'Open-source, BYOK data enrichment workflows.',
  title: 'BYOK Grid',
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  await connection();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
