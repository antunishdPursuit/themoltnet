import { defineConfig } from 'vitest/config';

// Opt-in benchmark; excluded from the package's default `src/**/*.test.ts` run.
export default defineConfig({
  test: { environment: 'node', include: ['bench/**/*.bench.ts'] },
});
