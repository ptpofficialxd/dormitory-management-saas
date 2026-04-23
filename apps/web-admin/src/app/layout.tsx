import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

/**
 * Root layout — applies to every route under `/app/**`.
 *
 * Locale `th` is the default per CLAUDE.md §3 #14. We don't import any web
 * font here yet — `IBM Plex Sans Thai` is referenced in `tailwind.config.ts`
 * `fontFamily.sans` and falls back to the system Thai font stack until we
 * decide whether to self-host or pull from Google Fonts.
 */

export const metadata: Metadata = {
  title: {
    default: 'Dorm Admin',
    template: '%s · Dorm Admin',
  },
  description: 'ระบบจัดการหอพัก — Dormitory / Apartment Management SaaS',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0f172a', // matches --primary in slate palette
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}
