import { defineConfig } from 'vitest/config';

// Consume workspace packages from source, like `tsx --conditions=source` does for the CLI. Tests run
// in Node (Vite's SSR path), so both the SSR conditions and the external-package conditions matter.
const conditions = ['source'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: { testTimeout: 60_000, server: { deps: { inline: ['@photobook/shared'] } } },
});
