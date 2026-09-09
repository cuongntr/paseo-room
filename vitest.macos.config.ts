import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/macos-gui.smoke.ts'],
    testTimeout: 300_000,
  },
});
