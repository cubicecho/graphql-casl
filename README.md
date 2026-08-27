# graphql-casl

A monorepo for the `@vantreeseba/graphql-casl` toolkit — CASL permission rules
for GraphQL resolvers.

## Packages

| Package | Description |
|---|---|
| [`@vantreeseba/graphql-casl`](./packages/graphql-casl) | The runtime: a `graphql-middleware` plugin for defining CASL permission rules on resolvers, with optional `/scoping` and `/envelop` entry points. See its [README](./packages/graphql-casl/README.md). |
| [`@vantreeseba/graphql-casl-codegen`](./packages/graphql-casl-codegen) | A GraphQL Code Generator plugin that emits subject bindings from your schema. See its [README](./packages/graphql-casl-codegen/README.md). |

## Development

This is an npm-workspaces monorepo.

```bash
npm install
npm run build        # build every package
npm test             # test every package
npm run typecheck    # type-check every package
npm run typecheck:tests
npm run check        # biome lint + format check (whole repo)
```

Run a script in a single package with `-w`:

```bash
npm run test -w packages/graphql-casl-codegen
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and
drive a single, repo-wide release via
[semantic-release](https://semantic-release.gitbook.io/): one version and tag for
the whole repo, with every package published together at that version.

## License

[MIT](LICENSE) © Benjamin Van Treese
