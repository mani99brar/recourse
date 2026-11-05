// Local two-anvil tests: one file at a time, long timeouts (they deploy contracts and wait on a
// relay process). Run under the suite lock; they start their own anvils on ports 8581 and 8582.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/anvil/**/*.test.ts'],
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
