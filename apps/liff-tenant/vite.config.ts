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
    // Bind to localhost only to prevent the LAN/WAN-exposed dev server
    // (the surface for the 2026-04-26 dev-server exploitation attempt —
    // wget|sh malware drop + Server Action enumeration from 176.65.134.6).
    // For LIFF testing on a real LINE client, use a tunneling tool (Pinggy /
    // cloudflared / ngrok) which proxies localhost → public HTTPS without
    // exposing the dev server directly. Tunnels also let you scope auth.
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Vite 5.4.18+ enforces Host header validation by default
    // (CVE-2025-31125 / CVE-2025-31486 / CVE-2025-32395 — DNS rebinding
    // protection). Bind-to-localhost above means external Hosts are rejected
    // unless explicitly allow-listed. We allow common tunneling vendors so
    // LIFF testing on real LINE clients keeps working — these are HTTPS-only
    // managed tunnels, so allowing the wildcard does NOT widen the attack
    // surface from the localhost-bound choice.
    allowedHosts: [
      '.trycloudflare.com', // Cloudflare Quick Tunnel (URL changes each run)
      '.ngrok.io',
      '.ngrok-free.app',
      '.pinggy.link',
      '.loca.lt', // localtunnel
    ],
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2022',
  },
});
