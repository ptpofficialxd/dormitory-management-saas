/**
 * Next.js config for `apps/web-admin`.
 *
 * Notes:
 * - `transpilePackages: ['@dorm/shared']` makes Next compile the shared TS
 *   sources directly (we don't ship a pre-built dist for shared in dev).
 * - `typedRoutes` gives us compile-time-checked Link href values once we
 *   start adding navigation.
 *
 * NOTE on `output: 'standalone'`:
 * - Originally enabled for ADR-0006 (apps must run on Node, not just Bun)
 *   but Next's standalone trace uses `fs.symlink()` which Windows blocks
 *   for non-admin users → builds fail with EPERM on Ice's dev box.
 * - Compile/typecheck/static-gen all succeed without it; only the trace
 *   copy fails. We re-enable standalone when:
 *     a) CI runs on Linux (no symlink restriction), OR
 *     b) we add a Dockerfile + multi-stage build, OR
 *     c) Ice enables Windows Developer Mode (Settings → For Developers).
 * - `bun run --cwd apps/web-admin start` still works in regular mode.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@dorm/shared'],
  experimental: {
    typedRoutes: true,
  },
};

export default nextConfig;
