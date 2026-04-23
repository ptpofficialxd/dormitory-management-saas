/**
 * Next.js config for `apps/web-admin`.
 *
 * Notes:
 * - `transpilePackages: ['@dorm/shared']` makes Next compile the shared TS
 *   sources directly (we don't ship a pre-built dist for shared in dev).
 * - `typedRoutes` gives us compile-time-checked Link href values once we
 *   start adding navigation.
 * - `webpack.resolve.extensionAlias` is REQUIRED to make `.js` specifiers
 *   inside `@dorm/shared` (and any other workspace ESM TS package) resolve
 *   to their `.ts(x)` sources. Background:
 *     - packages/shared follows Node's NodeNext ESM convention where
 *       internal imports use the OUTPUT filename, e.g. `import './foo.js'`
 *       even though the actual source is `./foo.ts`.
 *     - Vite (used by apps/liff-tenant) does this swap natively; Next's
 *       webpack does NOT until you opt in via `extensionAlias`.
 *     - Without this, you get cryptic "Module not found: Can't resolve
 *       './primitives.js'" errors deep inside the shared package.
 *
 * NOTE on `output: 'standalone'`:
 * - Originally enabled for ADR-0006 (apps must run on Node, not just Bun)
 *   but Next's standalone trace uses `fs.symlink()` which Windows blocks
 *   for non-admin users → builds fail with EPERM on Ice's dev box.
 * - Compile/typecheck/static-gen all succeed without it; only the trace
 *   copy fails. Re-enable when CI runs on Linux or Docker multi-stage.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@dorm/shared'],
  experimental: {
    typedRoutes: true,
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
    };
    return config;
  },
};

export default nextConfig;
