import { defineConfig } from 'vitest/config';

/**
 * This file exists for coverage. Everything else about how the API's tests run is the Vitest
 * default, on purpose.
 *
 * There is no threshold. A number that fails the build turns a coverage report into something
 * to satisfy, and the tests written to satisfy it are the ones that assert nothing. The target
 * is written down in AGENTS.md instead, where a person reads it and decides.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      // text for the terminal, html to click through, lcov for whatever reads it later.
      reporter: ['text', 'html', 'lcov'],
      // Report on everything shipped, not only on files a test happened to import. An
      // untested module showing up as a row of zeroes is the most useful line in the report.
      include: ['src/**/*.ts'],
      exclude: [
        // The process entry point. Covering it means starting the process.
        'src/index.ts',
        // Column and enum declarations. There is no branch in them to cover, and the
        // migration tests already assert what they built.
        'src/db/schema/**',
      ],
    },
  },
});
