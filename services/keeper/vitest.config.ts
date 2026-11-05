// Unit tests only. The two-anvil tests start chains and a relay process, so they run only through
// vitest.anvil.config.ts (pnpm test:anvil), never from a bare `vitest run`.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, 'test/anvil/**'],
  },
});
