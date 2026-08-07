import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Nawilis SPK',
  description: 'Intake SPK → MongoDB → Turboly',
  manifest: '/manifest.webmanifest',
  // Browser page-translation rewrites the DOM and crashes React interactivity
  // (and mangles service names) — block it; the form is intentionally Indonesian.
  other: { google: 'notranslate' },
};

export const viewport = {
  themeColor: '#1E2E91',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id" translate="no">
      <body>{children}</body>
    </html>
  );
}
