# AGENTS.md

## Project

An npm-workspaces monorepo for the `@vantreeseba/graphql-casl` toolkit:

- **`packages/graphql-casl`** — the runtime: a `graphql-middleware` plugin for
  defining [CASL](https://casl.js.org/) permission rules on resolvers. Rules are
  declared per type/field in a `PermissionsMap` and enforced before the resolver runs.
  Two optional subpath exports ride along: `/scoping` (`scopeArgs`) and
  `/envelop` (`useGraphQLCasl`, for hosts where the schema cannot be wrapped up
  front — Apollo Server 4+, federation, dynamically swapped schemas).
- **`packages/graphql-casl-codegen`** — a GraphQL Code Generator plugin that emits
  subject bindings (`SubjectMap`, `Subject`, `typed`, `ability`) from a schema.
- **`packages/graphql-casl-directives`** — `@can` / `@rule` SDL directives for
  schema-first users. `permissionsFromDirectives(schema, { can, rules })` reads
  them off a `GraphQLSchema` and returns the `PermissionsMap` the runtime
  enforces; it is a translator, not a second enforcer.

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
  no runtime dependencies. `@envelop/core >=5` and `@envelop/on-resolve >=7` are
  **optional** peers (`peerDependenciesMeta`) — npm installs them only for
  consumers who import `/envelop`, which is how that entry point can have a real
  runtime requirement without the main entry point growing a dependency. Keep it
  that way: `src/index.ts` must never import `src/envelop.ts`, or `dist/index.d.ts`
  would reference `@envelop/core` for everyone
- **graphql-casl-codegen peer deps:** `@graphql-codegen/plugin-helpers >=5`, `graphql >=16`,
  `@vantreeseba/graphql-casl` (the runtime its generated code imports from)
- **graphql-casl-directives peer deps:** `graphql >=16`, `@vantreeseba/graphql-casl >=1.5.0`
  (it imports `and` / `or` / `PermissionsError` from the runtime). Its tests and
  typecheck resolve the runtime through the workspace symlink to
  `packages/graphql-casl/dist`, so build the runtime first — CI builds before it
  typechecks or tests
- **Releases:** a single, repo-wide version via root `semantic-release` (one `v${version}`
  tag); `@semantic-release/exec` publishes every workspace together

## Project structure

```
packages/
  graphql-casl/
    src/
      index.ts            — public API entry point (re-exports + package overview)
      schemaTypes.ts      — type helpers derived from generated Resolvers/ResolversTypes
      rules.ts            — rule layer (Rule, CheckableRule, rule, PermissionsMap, accept, deny)
      combinators.ts      — and / or / not / chain / race over CheckableRules, plus wrap,
                            which nests any rules as middleware
      applyPermissions.ts — validates a PermissionsMap against the schema, resolves it to a
                            per-field rule lookup, and applies it via graphql-middleware
      ability.ts          — CASL Action/Actions + the loose AbilityLike shape
      accessibleBy.ts     — folds an ability into a query filter (row-level filtering)
      conditions.ts       — the FilterAdapter union (skeleton/leaf) + the conditions walker
      scoping.ts          — OPTIONAL subpath export `/scoping`: scopeArgs rewrites a field's
                            filter argument instead of allowing or denying the field
      envelop.ts          — OPTIONAL subpath export `/envelop`: useGraphQLCasl enforces the
                            same map through envelop instead of graphql-middleware
      internal.ts         — symbols shared between modules that must not import each other
      graphqlAbility.ts   — GraphQLAbility, createGraphQLAbility, buildGraphQLAbility
      validateGraphQLRules.ts — checks stored ability rules (subjects, fields, conditions) against
                            the runtime schema; the DB-rules counterpart of validatePermissions
      subjects.ts         — subjectsOf / createTyped
      createCan.ts        — factory tying a CASL ability to the rule layer
    test/
      permissions.test.ts                — unit tests for the rule primitives
      applyPermissions.test.ts           — the schema walk: enforcement + validation errors
      combinators.test.ts                — rule(), the combinators, wrap, operand validation
      accessibleBy.test.ts               — ability -> query filter, priority flattening, adapters
      conditions.test.ts                 — the leaf walker, plus a row-by-row cross-check vs ability.can
      graphqlAbility.test.ts             — typed ability: conditions, operators, stored-rule rehydration
      validateGraphQLRules.test.ts       — stored rules vs the schema: every rejection, and what rehydration lets through
      example.test.ts                    — runnable "todos" worked example / reference docs
      example.codegen.ts                 — trimmed `graphql-codegen` output the example consumes
      envelop.test.ts                    — the `/envelop` plugin, end-to-end through envelop's testkit
      integration/permissions.integration.test.ts — end-to-end test against an executable schema
      integration/scoping.integration.test.ts     — scopeArgs (and wrap) against a
                                                    generated-CRUD-shaped schema
      recipes/drizzleGraphql.ts          — copy-paste FilterAdapter for drizzle-graphql's
                                           generated filters; a recipe, not a public export
      recipes/drizzleGraphql.test.ts     — its tests, incl. the legal-filter assertion
  graphql-casl-codegen/
    src/index.ts        — the codegen plugin (plugin + validate + config)
    test/plugin.test.ts — plugin output + config tests
  graphql-casl-directives/
    src/index.ts             — `directiveTypeDefs` + `permissionsFromDirectives` (the translator)
    test/directives.test.ts  — end-to-end: SDL → map → applyPermissions → queries, plus
                               every validation problem and the envelop plugin
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
- `createCan` / `subjectsOf` / `createTyped` are factories bound to the
  consumer's context shape and ability builder — keep auth/ability logic out of
  the library core
- `accept` and `deny` are the always-pass / always-fail rule primitives
- Rules gate a whole field; `accessibleBy` is the row-level counterpart, handing a
  resolver a query filter instead. Its `null` return means deny-all, not "no filter"
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
