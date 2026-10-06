import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { conditions: ['source'] },
  test: { include: ['src/**/*.test.ts'], testTimeout: 30_000, hookTimeout: 120_000 },
});
