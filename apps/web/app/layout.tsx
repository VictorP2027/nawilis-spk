import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Nawilis SPK',
  description: 'Intake SPK → MongoDB → Turboly',
  manifest: '/manifest.webmanifest',
};

export const viewport = {
  themeColor: '#0a3d8f',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body>{children}</body>
    </html>
  );
}
