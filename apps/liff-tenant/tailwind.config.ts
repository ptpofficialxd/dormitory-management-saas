import type { Config } from 'tailwindcss';

/**
 * Tailwind config — mobile-first per CLAUDE.md §3 rule #6 (LIFF ≥375px).
 * Default Tailwind breakpoints already start mobile-first (sm @ 640px),
 * so no breakpoint customisation needed for the bind flow.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Use system Thai-friendly stack; LIFF runs in the LINE in-app browser
        // which uses the device's default Thai font (Noto Sans Thai on Android,
        // Thonburi on iOS). Don't load remote fonts — costs LIFF launch latency.
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          'Roboto',
          '"Helvetica Neue"',
          'Arial',
          '"Noto Sans Thai"',
          '"Sukhumvit Set"',
          'sans-serif',
        ],
      },
      colors: {
        // LINE brand-friendly accent (matches LINE Login green).
        'line-green': '#06C755',
      },
    },
  },
  plugins: [],
} satisfies Config;
