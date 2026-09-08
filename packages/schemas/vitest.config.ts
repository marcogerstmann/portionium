import { defineConfig } from 'vitest/config';

/** Coverage only, see api/vitest.config.ts for why there is no threshold. */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
    },
  },
});
