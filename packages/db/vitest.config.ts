import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    include: ['src/**/*.test.ts'],
    testTimeout: 15_000,
    // RLS tests set session-local Postgres variables via a real connection.
    // Running in parallel would race on the shared DB — force single-thread.
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
      },
    },
    // Run a setup file that truncates test tables before each file.
    // (Created in a later step when we add more test files.)
  },
});
