import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/*.integration.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: ['./src/test-setup.ts'],
    // Vitest 4 flattened poolOptions — forks config is now top-level.
    pool: 'forks',
    forks: { singleFork: true },
    sequence: { concurrent: false },
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
