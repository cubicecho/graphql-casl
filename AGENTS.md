# AGENTS.md

## Project

An npm-workspaces monorepo for the `@vantreeseba/graphql-casl` toolkit:

- **`packages/graphql-casl`** — the runtime: a `graphql-middleware` plugin for
  defining [CASL](https://casl.js.org/) permission rules on resolvers. Rules are
  declared per type/field in a `PermissionsMap` and enforced before the resolver runs.
- **`packages/graphql-casl-codegen`** — a GraphQL Code Generator plugin that emits
  subject bindings (`SubjectMap`, `Subject`, `typed`, `ability`) from a schema.

## Specifications

Deferred work is tracked per package (`packages/graphql-casl/TODO.md`) and in
`.agents/*.todo.txt`. Usage is documented in each package's README.

## Stack

- **Language:** TypeScript 5, strict mode, ESM only
- **Monorepo:** npm workspaces; run scripts at root (delegates to packages via
  `--workspaces`) or target one with `-w packages/<name>`
- **Tests:** Vitest (`npm test`)
- **Formatting/linting:** Biome (`npm run check`) — single root config, whole repo
- **Build:** `tsc` per package (`npm run build`) — outputs to each package's `dist/`
- **API docs:** TypeDoc (`npm run docs`) — `packages/graphql-casl/docs/api/`
  (generated, not committed; CI publishes them to the GitHub Wiki on `main`)
- **graphql-casl peer deps:** `@casl/ability >=6`, `graphql >=16`, `graphql-middleware >=6`;
  no runtime dependencies
- **graphql-casl-codegen peer deps:** `@graphql-codegen/plugin-helpers >=5`, `graphql >=16`,
  `@vantreeseba/graphql-casl` (the runtime its generated code imports from)
- **Releases:** a single, repo-wide version via root `semantic-release` (one `v${version}`
  tag); `@semantic-release/exec` publishes every workspace together

## Project structure

```
packages/
  graphql-casl/
    src/
      index.ts            — public API entry point (re-exports + package overview)
      schemaTypes.ts      — type helpers derived from generated Resolvers/ResolversTypes
      rules.ts            — graphql-middleware rule layer (Rule, PermissionsMap, accept, deny)
      applyPermissions.ts — validates a PermissionsMap against the schema and applies it
      ability.ts          — CASL Action/Actions + the loose AbilityLike shape
      graphqlAbility.ts   — GraphQLAbility, createGraphQLAbility, buildGraphQLAbility
      subjects.ts         — createSubjects / createTyped
      createCan.ts        — factory tying a CASL ability to the rule layer
    test/
      permissions.test.ts                — unit tests for the rule primitives
      applyPermissions.test.ts           — the schema walk: enforcement + validation errors
      graphqlAbility.test.ts             — typed ability: conditions, operators, stored-rule rehydration
      example.test.ts                    — runnable "todos" worked example / reference docs
      example.codegen.ts                 — trimmed `graphql-codegen` output the example consumes
      integration/permissions.integration.test.ts — end-to-end test against an executable schema
  graphql-casl-codegen/
    src/index.ts        — the codegen plugin (plugin + validate + config)
    test/plugin.test.ts — plugin output + config tests
vitest.config.ts (per package) — dedupes/inlines graphql so it loads as a single instance
```

## Key conventions

- All exports go through `src/index.ts`
- The library is **schema-agnostic**: type helpers (`SubjectName`, `SubjectMap`,
  `ArgsOf`, `ParentOf`, `ContextOf`) are derived from the consumer's generated
  `Resolvers` / `ResolversTypes` — never hardcode domain type names in the library
- Subjects are detected by `__typename`: `createTyped()` tags objects with a required,
  narrowed `__typename`, which CASL's `TaggedInterface` natively accepts (so no
  `__caslSubjectType__` is used)
- `GraphQLAbility<SubjectMap>` is a CASL `MongoAbility` (built via `createMongoAbility`,
  so conditions use CASL's mongo-query operators `$eq`/`$in`/`$gt`/… and its built-in
  `mongoQueryMatcher`); `createGraphQLAbility` gives statically-typed `can`/`cannot`
  conditions via a `__typename`-tagged subject tuple. There is no untyped ability path
- Rules are plain JSON: persist `builder.rules` / `ability.rules` and rehydrate with
  `buildGraphQLAbility(rules)` (for DB-backed, cached-at-startup authorization)
- `createCan` / `createSubjects` / `createTyped` are factories bound to the
  consumer's context shape and ability builder — keep auth/ability logic out of
  the library core
- `accept` and `deny` are the always-pass / always-fail rule primitives
- A failed auth check throws `Not authenticated`; a failed ability check throws `Forbidden`
- Tests live in `test/` (parallel to `src/`); integration tests go under `test/integration/`

## Commit conventions

- **Use Conventional Commits** (semantic commits) for every commit:
  `type(scope): summary`, e.g. `feat: add field-level rules`, `fix: handle null subject`,
  `docs: clarify README`, `test:`, `chore:`, `refactor:`, `ci:`.
- Keep the summary imperative and under ~72 characters; add a body when the why
  isn't obvious from the diff.
- One logical change per commit.
- Commit messages **drive the (repo-wide) release** — `feat:` triggers a minor
  bump, `fix:` a patch, and a `BREAKING CHANGE:` footer a major.
  `chore:`/`docs:`/`test:`/`ci:` do not publish. A scope is optional but useful
  for clarity (e.g. `feat(codegen): …`); versioning is unified, so any release
  publishes every package.

## CI & releases

Two GitHub Actions workflows:

- **`.github/workflows/test.yml`** — runs on every push: biome check, typecheck,
  test, coverage, build (all via root scripts that fan out to workspaces), then
  publishes TypeDoc from `packages/graphql-casl/docs/api/` to the wiki on `main`.
- **`.github/workflows/release.yml`** — runs after **Test** succeeds on `main`,
  then runs `npx semantic-release` once at the repo root.

Releases use a **single, repo-wide version** ([semantic-release](https://semantic-release.gitbook.io/)
at the root, `.releaserc.json`): one `v${version}` git tag and one GitHub release
drive the version, and `@semantic-release/exec` bumps and publishes **every**
workspace together (`npm version … --workspaces`, then `npm publish --workspaces`)
— even a package with no changes ships at the new shared version. The root
`package.json` is `private`, so only the public sub-packages publish.

- Requires repo secret **`NPM_ACCESS_TOKEN`** (or OIDC trusted publishing).
  `GITHUB_TOKEN` is provided by Actions.
- The plain `v${version}` tag format continues the existing `v0.x` tag history
  (no migration/seeding needed). Validate with `npx semantic-release --dry-run`
  at the root.

## Running locally

```bash
npm install
npm test        # vitest across all packages
npm run build   # compile every package to its dist/
npm run check   # biome lint + format check (whole repo)

npm run test -w packages/graphql-casl-codegen  # one package
```
