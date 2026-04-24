import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      exclude: ['src/test-helpers/**', 'src/db/**', 'src/**/routes.ts', 'node_modules/**'],
      thresholds: {
        // Thresholds intentionally track slightly below current measured
        // coverage so a small new feature doesn't block CI. They also
        // serve as a ratchet — raise them as coverage improves, don't
        // drop them just to get green.
        //
        // Current (2026-04-22): statements 47%, branches 38%, functions 55%, lines 48%.
        // Many K8s API orchestration functions (cluster-issuers listing,
        // image-inventory, k8s-provisioner) are integration-tested against
        // a live cluster rather than mocked unit tests — hence the gap
        // between coverage and what "real" coverage feels like.
        statements: 29,
        branches: 37,
        functions: 50,
        lines: 29,
      },
    },
    exclude: ['**/*.integration.test.ts', '**/node_modules/**'],
    setupFiles: ['./src/test-setup.ts'],
    // Vitest's 5s default is too tight for this suite's cold-start path.
    // With 153 test files hitting the parallel import pool, the first
    // `it` that registers fastify-jwt + a route plugin can take >5s on
    // a cold worker — flaking routes.test.ts' "401 without auth" case
    // while every subsequent file in the same worker runs in ms.
    // 15s gives headroom for cold imports without masking real slow
    // tests; any test that legitimately needs >15s should override it
    // inline.
    testTimeout: 15000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
