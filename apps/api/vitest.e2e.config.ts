import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * E2E test runner — touches real Postgres + seeds, so tests run serially
 * (no DB isolation between parallel workers in MVP). Separated from unit
 * config so `bun run test` stays fast + hermetic.
 *
 * Why SWC instead of Vitest's default esbuild transformer:
 *   esbuild strips TypeScript decorators but does NOT emit the
 *   `design:paramtypes` / `design:type` metadata that NestJS DI needs to
 *   resolve constructor params. Without it, `Reflector`, `JwtService`, etc.
 *   arrive as `undefined` in every `@Injectable()` constructor and the first
 *   guard call blows up with `Cannot read properties of undefined (reading
 *   'getAllAndOverride')`. SWC with `decoratorMetadata: true` mirrors what
 *   `tsc --emitDecoratorMetadata` does, so the compiled test output matches
 *   what Nest sees in production.
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
    }),
  ],
  test: {
    globals: false,
    environment: 'node',
    include: ['test/**/*.e2e-test.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    // `reflect-metadata` must be loaded once per worker BEFORE any Nest
    // module imports run — it installs the `Reflect.defineMetadata` hooks
    // that SWC-emitted metadata calls target.
    setupFiles: ['reflect-metadata'],
  },
});
