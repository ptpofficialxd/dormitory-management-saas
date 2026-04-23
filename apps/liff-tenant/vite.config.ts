import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * Vite config for `apps/liff-tenant`.
 *
 * Notes:
 * - LIFF requires HTTPS in production (LINE in-app browser blocks http://). Dev
 *   uses Vite's default http://localhost:5173 — when testing on a real LINE
 *   client, tunnel via ngrok / cloudflared and register the tunnel URL as the
 *   LIFF endpoint URL in the LINE Developer Console.
 * - `base: './'` so the built bundle works under any path the LIFF endpoint URL
 *   maps to (e.g. `https://example.com/liff/` or root). Vite emits relative
 *   asset URLs which the LIFF redirect can host anywhere.
 * - Path alias `@/` mirrors apps/api convention for in-app imports.
 * - `@dorm/shared` is resolved via TS paths in dev (no bundler config needed —
 *   Vite reads `tsconfig.json` paths automatically when via `vite-tsconfig-paths`
 *   plugin OR when the source files are inside the workspace tree, which they
 *   are). To be explicit and avoid runtime surprises, we also alias here.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  // Load `VITE_*` vars from the monorepo-root `.env` (matches apps/api pattern).
  // Vite still respects the `VITE_` prefix — anything else stays unavailable to
  // the client bundle.
  envDir: path.resolve(__dirname, '../..'),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@dorm/shared': path.resolve(__dirname, '../../packages/shared/src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
