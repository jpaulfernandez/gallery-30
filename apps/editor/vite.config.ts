import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defaultClientConditions } from 'vite';
import { defineConfig } from 'vitest/config';

const host = process.env.TAURI_DEV_HOST;

// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // Consume workspace packages from source (see the "source" export condition).
    conditions: ['source', ...defaultClientConditions],
  },
  // Vitest externalizes workspace packages and resolves them with Node, which would pick the built
  // `dist/`. Inline shared so it is consumed from source like in dev, with no prebuild needed.
  ssr: { resolve: { conditions: ['source', 'import', 'module', 'default'] } },
  test: { server: { deps: { inline: ['@photobook/shared'] } } },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'safari16',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
