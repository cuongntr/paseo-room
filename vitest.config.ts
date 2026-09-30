import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.package.test.ts'],
    // The suite often shares its host with live room seats. Under that load a CLI test that takes
    // half a second alone once overran the default 5 s bound. A test long by design keeps its own
    // longer bound.
    testTimeout: 15_000,
  },
});
