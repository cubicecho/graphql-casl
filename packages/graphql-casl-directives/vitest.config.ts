import { defineConfig } from 'vitest/config';

// graphql throws "another module or realm" when it is loaded more than once.
// Under vitest's SSR loader the package can be pulled in as both CJS and ESM,
// so dedupe it to a single instance and inline it — plus the runtime, the
// graphql-tools / middleware / envelop packages that also import it — through
// vitest's transform, so every import of `graphql` resolves to one instance.
export default defineConfig({
  resolve: {
    dedupe: ['graphql'],
  },
  test: {
    server: {
      deps: {
        inline: [
          'graphql',
          /@graphql-tools\//,
          /@envelop\//,
          /@vantreeseba\//,
          'graphql-middleware',
        ],
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
