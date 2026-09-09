import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test/paseo-isolated.contract.ts'], testTimeout: 240_000 } });
