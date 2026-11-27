import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify('0.0.0-test'),
  },
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
      '@main': fileURLToPath(new URL('./src/main', import.meta.url)),
      '@renderer': fileURLToPath(new URL('./src/renderer', import.meta.url)),
      '@harness': fileURLToPath(new URL('./src/harness', import.meta.url)),
    },
  },
  // Renderer tests (*.test.tsx) render components with react-dom/server; React 19 automatic JSX runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 20_000,
    // Cleanups delete big throwaway trees (e.g. a 50k-file worktree); slow when the disk is busy.
    hookTimeout: 60_000,
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
  },
});
