import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run against the runtime's SOURCE, not its dist/: the two packages are
// built in one pass, so a test resolving `dist` would either be stale or, on a
// fresh checkout, missing.
const runtime = fileURLToPath(new URL('../graphql-casl/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@vantreeseba/graphql-casl': runtime },
    // Keep graphql a single instance under vitest's SSR loader (it throws
    // "another module or realm" when loaded as both CJS and ESM).
    dedupe: ['graphql'],
  },
  test: {
    server: {
      deps: {
        // Everything, not just graphql: envelop and graphql-tools load graphql
        // themselves, and an externalized dependency gets the CJS build while
        // the inlined source gets the ESM one — two realms, one schema.
        inline: [/@envelop\//, /@graphql-tools\//, 'graphql'],
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
