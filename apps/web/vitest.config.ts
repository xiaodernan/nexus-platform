import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Unit tests for the pure logic in `src/lib` (fact resolution, stale handling, money/distance
 * formatting, Intent merge echo, SEO gating). UI rendering is covered by the Playwright
 * evidence script (§156 "UI → browser → screenshot"), not by jsdom snapshots.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@nexus/ui/trust/fact': fileURLToPath(new URL('../../packages/ui/src/trust/fact.ts', import.meta.url)),
      '@nexus/ui/trust/types': fileURLToPath(new URL('../../packages/ui/src/trust/types.ts', import.meta.url)),
      '@nexus/ui': fileURLToPath(new URL('../../packages/ui/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    reporters: ['default'],
  },
});
