import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Unit test runner — hermetic, no DB/network. SWC plugin is mirrored from
 * `vitest.e2e.config.ts` so decorator metadata emission is identical in both
 * suites (NestJS DI depends on `design:paramtypes`; esbuild does not emit it).
 *
 * See `vitest.e2e.config.ts` for the rationale behind the `as any` cast
 * (TS2769 spurious nominal mismatch from Bun's duplicate `vite` copies under
 * isolated install).
 */
export default defineConfig({
  plugins: [
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
        target: 'es2022',
      },
      sourceMaps: true,
    }) as any,
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist', 'test/**'],
    testTimeout: 10_000,
    setupFiles: ['reflect-metadata'],
  },
});
