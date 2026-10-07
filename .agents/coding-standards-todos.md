# Coding standards ledger

Findings from the `coding-standards` skill's refactor workflow. This file lives at
`.agents/coding-standards-todos.md`. IDs are stable — don't renumber when items are removed.
`(unverified)` marks items inferred from docs or naming rather than confirmed in code.
Nothing here is implemented until approved.

Baseline, 2026-10-07, `main` at `7292fe4`: build, `npm run check`, `typecheck` and
`typecheck:tests` clean; 518 + 8 + 46 tests pass. The hot-path bench was not run.

## Model

Not ledger items in themselves; the `R` items below say which of these they implement.

- **M1 — one module per concept in the permission layer.** `applyPermissions.ts` (1,341
  lines, the most-changed source file) owns five ideas: the map-vs-schema check, rule
  precedence (own entry, wildcard, interface, fallback), denial delivery and reporting,
  error control, and applying to a schema. `validateGraphQLRules.ts`, `envelop.ts` and
  `apollo.ts` each import it for one unrelated piece.
- **M2 — one helper per repeated mechanism.** "A value that can key a per-request
  `WeakMap`", "get the entry or create it" and "continue now if the answer is ready, else
  when it settles" are each written out at every use.
- **M3 — the scope mark has one reader and one writer.** Four modules read or write
  `SCOPE_INFO` with their own cast.
- **M4 — a denial is always an `Error`.** `denialFrom` returns `Error | undefined`, so
  callers that know they are denying carry an unreachable `?? new Error('Forbidden')` or an
  `as Error`.

## Summary

| Prefix | Kind |
|---|---|
| `R` | Refactor: same behavior, better shape |
| `F` | Feature: new behavior |
| `T` | Test work |
| `D` | Comment or doc that no longer matches the code |
| `B` | Bug, or near copies that behave differently |
| `A` | Public API change; needs a decision |

| ID | Kind | What it does | Buys | Needs | Status |
|---|---|---|---|---|---|
| R1 | Refactor [pattern] | Splits the 1,341-line permission module into one file each for the map check, rule precedence, denials, error control and applying, with the public exports unchanged. | M1; the file changed 17 times last year | — | done |
| R2 | Refactor [readability] | Breaks the 105-line, deeply nested map-problem collector into one named check per kind of problem. | M1; the worst complexity hit in the repo | R1 | done |
| R3 | Refactor [reuse] | Replaces four hand-written copies of "can this value key a WeakMap" with one shared helper. | M2 | — | done |
| R4 | Refactor [reuse] | Replaces nine written-out "get the map entry or create it" blocks with one helper, outside the per-field hot path. Done for the wiring-time lookups; the per-field copies (`memoize`, `tag`, `deliver`) and the directives translator keep theirs. | M2 | — | done |
| R5 | Refactor [reuse] | Replaces about eight written-out "run now if ready, else when the promise settles" branches with one helper. Done at the three sites that need no per-call closure (`or`, `not`, `createCan`); the other five stay inline. | M2 | T2 | done |
| R6 | Refactor [reuse] | Gives the argument-scoping mark one read function and one write function, removing four casts. | M3 | — | done |
| R7 | Refactor [simplify] | Adds a denial constructor that always returns an error, removing three unreachable fallbacks and two casts, and names the two denial messages. | M4 | — | done |
| R8 | Refactor [reuse] | Makes the per-field ability check reuse the same verdict function as the main check instead of a second inline copy. | Two copies that must stay in step | — | open |
| R9 | Refactor [consistency] | Derives the leaf-operator type from one list instead of a hand-synced type and set, and shares the group-operator list between the two condition walkers. | A new operator added in one place only | — | open |
| R10 | Refactor [simplify] | Replaces the one constructor parameter property with an ordinary field, so the code is erasable-syntax clean. | Lets the compiler flag be turned on (R16) | — | done |
| R11 | Refactor [readability] | Rewrites the three nested ternaries as named branches or a lookup table. | Readability | — | open |
| R12 | Refactor [sweep] | Puts braces on all 198 single-line `if`/`for` bodies and turns the lint rule on so they stay. | Sweep (P15) | — | done |
| R13 | Refactor [sweep] | Rewrites logic negations written with `!` as positively named conditions, keeping `!` for null guards. | Sweep (P20) | — | done |
| R14 | Refactor [sweep] | Names the 24 magic numbers and the mode strings compared inline (`'filter'`, `'mask'`, `'explicit'` and so on) through internal constants. | Sweep (P16) | — | done |
| R15 | Refactor [sweep] | Removes type assertions where a type guard or better typing can do the job, starting with the eight `as never` / `as unknown as` cases. | Sweep (P17) | R6, R7 | done |
| R16 | Refactor [consistency] | Adopts the house Biome and compiler settings (120 columns, strict rules, erasable syntax only), which reformats most files. | House tooling parity | R10, R12 | done |
| T1 | Test [reuse] | Moves test helpers copied across files (ability builder, sync resolver, fake resolve info, problem collector) into one shared helper module. | One fixture to change instead of three | — | open |
| T2 | Test [pin] | Records the hot-path benchmark before and after the helper refactors, since they touch per-field code. Paired in-process run, 120 alternating rounds: every case within ±3% of baseline, control ±5%. | Protects R4, R5 | — | done |
| D1 | Docs | Reattaches two doc comments that sit above the wrong declaration, one of which leaves `resolvePermissions` with no API documentation. | Published API docs | — | done |
| D2 | Docs | Fixes three small comment errors: a stray backtick, a doubled "and", and two spellings of the `@throws` tag. | Accuracy | — | done |
| D3 | Docs [sweep] | Adds `@param` and `@returns` tags to the module-level functions that lack them. | Sweep (P4) | — | done |
| B1 | Bug? | Stored-rule validation accepts `$not`, `$mod` and `$options`, which a leaf adapter then rejects at request time; decide whether validation should warn. Fixed as an additive option, `operators: 'leaf'`. | A rule that passes the check and fails mid-query | — | done |
| A1 | API change | Exports named constants for the mode strings (as `Actions` already does for actions); additive, a minor release. | Consumers stop typing raw strings | R14 | done |
| A2 | API change | Exports the wildcard key and an action guard from the runtime so the directives package stops keeping its own copies; additive, a minor release. | One definition across packages | — | done |
| R17 | Refactor [consistency] · low value | Renames source and test files from camelCase to kebab-case. | House naming only | — | open |
| R18 | Refactor [consistency] · low value | Switches relative imports from `.js` to `.ts` extensions with compiler rewriting. | House import style only | — | open |
| R19 | Refactor [pattern] · low value | Groups the flat source directory into domain folders. | House layout only | R1 | open |
| D4 | Docs [sweep] · low value | Shortens doc comments to four sentences and moves the rest under `@remarks`. | Sweep (P19) | — | done |
| D5 | Docs [sweep] · low value | Removes the 14 divider comments in tests. | Sweep (P5) | — | done |
| T3 | Test [consistency] · low value | Splits `permissions.test.ts` so each test file mirrors one source file. | Test layout | — | open |

Status is `open`, `approved`, `declined` or `done`.

## Conventions

The canonical way this codebase does things. New code and refactors follow these.

- Missing lookups and failures: throw with a teaching message prefixed `graphql-casl:`.
  Validation collects every problem and throws one `PermissionsError`.
- Authorization failures are values, not throws: a check returns `false`, a string or an
  `Error`; a throw means the rule broke.
- Per-field code stays synchronous when its inputs are; comments mark these paths. Do not
  add a promise hop or a per-call closure there without a bench run.
- Shared internals live in: `src/internal.ts`. Public exports go only through `src/index.ts`,
  which must never import `src/envelop.ts`.
- Test helpers live in: each test file today (see T1).
- Generated files and the command that rebuilds them: `dist/` → `npm run build`;
  `packages/graphql-casl/docs/api/` → `npm run docs`. Neither is committed.
- Commits: Conventional Commits. `refactor:`, `docs:`, `test:`, `chore:` do not publish.
- Vendored code: the Standard Schema block in `validateArgs.ts` is copied verbatim, with
  its divider comments. Leave it as is.

## Refactoring

### R1 [pattern] — split `applyPermissions.ts` by concept

**File:** `packages/graphql-casl/src/applyPermissions.ts:1-1341` Target files, flat in
`src/` like the rest: `permissionsError.ts` (`PermissionsError`, `describeKind`),
`mapValidation.ts` (the problem collectors, `validatePermissions`), `rulePrecedence.ts`
(supertypes, `ruleForField`), `denials.ts` (`DenialMode`, `DenialReport`, masks, `deliver`,
`reportDenials`, the two exported constants), `errorControl.ts` (`FallbackError`,
`withErrorControl`), leaving `applyPermissions.ts` with the options, `resolvePermissions`,
in-place guarding and `applyPermissions`. `index.ts`, `envelop.ts`, `apollo.ts` and
`validateGraphQLRules.ts` import from the new owners. The package `exports` map only
exposes `index`, `scoping`, `envelop` and `apollo`, so no consumer path changes. Update the
structure listing in `AGENTS.md` in the same commit. Implements: M1.

### R2 [readability] — decompose `collectProblems`

**File:** `packages/graphql-casl/src/applyPermissions.ts` (`collectProblems`, about 105
lines) One function per kind of problem (unknown type, inert entry, non-function rule,
unknown field, scope target), each appending to the list. Messages are pinned by exact-match
tests in `applyPermissions.test.ts`. Implements: M1. Needs: R1.

### R3 [reuse] — one "can key a WeakMap" guard

**File:** `rules.ts:218` (`isObject`), `grants.ts:35` (`isObject`),
`applyPermissions.ts:503` (`isRecordable`), `createCan.ts:419` (inline). All four test
"non-null object or function". Target: one `isWeakKey` in `internal.ts`. Removes the
`context as unknown as object` cast at `createCan.ts:422`. Implements: M2.

### R4 [reuse] — one get-or-create helper

**File:** `applyPermissions.ts:134-136`, `243-245`, `909-919` (twice), `envelop.ts:112-116`,
directives `src/index.ts:272-279`; hot-path copies in `rules.ts` (`memoize`, twice) and
`grants.ts:51-60` (twice). Apply to the wiring-time sites only; the per-field copies stay
as loops unless T2 shows no cost. Implements: M2. Needs: T2 for the hot-path copies.

### R5 [reuse] — one sync-or-async continuation helper

**File:** `combinators.ts:155-157`, `194`, `298`; `createCan.ts:454`; `validateArgs.ts:250-257`;
`grants.ts:128-137`; `applyPermissions.ts:786-794`; `rules.ts` (`rule`). The shape is
`isThenable(x) ? Promise.resolve(x).then(f) : f(x)`. Target: `settled(value, onValue)` next
to `isThenable`. All sites are per-field. Implements: M2. Needs: T2.

### R6 [reuse] — one reader and writer for the scope mark

**File:** reads with a cast at `combinators.ts:387`, `grants.ts:143`, `applyPermissions.ts`
(`scopeTargetsOf`); writes at `combinators.ts:393`, `grants.ts:144`, `scoping.ts:188`.
Target: `scopeInfoOf(rule)` and `markScope(rule, info)` in `internal.ts`, and the same pair
for `CAN_INTERNALS` (`createCan.ts:637`, `scoping.ts:139`). Implements: M3.

### R7 [simplify] — a denial constructor that always returns an error

**File:** `scoping.ts:170`, `createCan.ts:438`, `createCan.ts:624-625` (unreachable
fallbacks); `validateArgs.ts:278`, `applyPermissions.ts:763` (`as Error`). Also names
`'Forbidden'` (`rules.ts`, `scoping.ts:170`) and `'Not authenticated'` (`createCan.ts:438`,
`452`) as constants. Implements: M4.

### R8 [reuse] — `fields` reuses `verdict`

**File:** `createCan.ts:484-491` and `574-575`. The second is the first plus a field name.
Give `verdict` an optional field argument. The two prologues (`authorize`, which throws, and
`withAbility`, which returns) stay: one serves rules that run the resolver.

### R9 [consistency] — one source for each operator list

**File:** `conditions.ts:24-53` (`LeafOperator` type and `LEAF_OPERATORS` set, 13 members
each, kept in step by hand); `conditions.ts:160` and `validateGraphQLRules.ts:81` (the
`$and`/`$or`/`$nor` group, written twice). Derive the type from an `as const` list; export
the group list from `conditions.ts`. `LeafOperator` stays the same public type.

### R10 [simplify] — remove the parameter property

**File:** directives `src/index.ts:203-206`. The only `noParameterProperties` hit.

### R11 [readability] — unnest three ternaries

**File:** `applyPermissions.ts:1069-1070` (`denialModeOf`), `scoping.ts:177-182`,
directives `src/index.ts:286-291` (a lookup keyed on directive name, P24). Also
`conditions.ts:164-166`, a three-way `if`/`else` on the group key that fits the same table.

### R12 [sweep] — apply P15 (braced bodies) across all packages

**Hits:** 198 by `useBlockStatements`; `applyPermissions.ts` 57, `rules.ts` 16,
`validateGraphQLRules.ts` 16, `createCan.ts` 11, the rest under 10 each. The project's
written rules do not ask for either style. Biome can apply the fix; turn the rule on in
`biome.json` in the same commit.

### R13 [sweep] — apply P20 (negation) across all packages

**Hits:** about 90 `!` uses, roughly half of them null guards that stay. Logic negations
such as `!allowExternalErrors`, `!isLeafAdapter(adapter)`, `!warned` become positively
named constants compared with `=== false`.

### R14 [sweep] — apply P16 (named values) across all packages

**Hits:** 24 by `noMagicNumbers`, plus inline closed-set strings: `'reject'`, `'filter'`,
`'mask'`, `'errors'`, `'extensions'`, `'default'`, `'explicit'`, `'warn'`, `'throw'`,
`'allow'`, `'deny'`, `'nothing'`, `'schema'`, `'none'`, and the cache modes. Internal
`as const` objects with the public unions derived from them; the union types do not change.
Exporting the objects is A1.

### R15 [sweep] — apply P17 (type assertions) across `src`

**Hits:** about 70 outside `as const`. Worst kinds: `createCan.ts:422`, `scoping.ts:154`,
`scoping.ts:160`, `rules.ts:342`, `internal.ts:11`, `internal.ts:20`, `subjects.ts:106`,
`graphqlAbility.ts:100`. Some are honest bridges to CASL's types and stay with their
comment. Needs: R6, R7, which remove six.

### R16 [consistency] — house Biome and compiler settings

**File:** `biome.json`, each `tsconfig.json`. Today: recommended preset, 100 columns. House:
120 columns, `useBlockStatements`, `noMagicNumbers`, `noNonNullAssertion`, `noExplicitAny`,
the negation plugin, `erasableSyntaxOnly`, `verbatimModuleSyntax`. The width change alone
reformats most files, so it should be its own commit. Needs: R10, R12.

---

## Tests

### T1 [reuse] — shared test helper module

**File:** `abilityWith` identical in `test/accessibleBy.test.ts:10` and
`test/recipes/drizzleGraphql.test.ts:9`; `syncResolve` identical in `test/grants.test.ts:83`
and `test/combinators.test.ts:707`, inline at `test/validateArgs.test.ts:152`; a fake
`GraphQLResolveInfo` cast five times in `test/permissions.test.ts` and `test/grants.test.ts`;
`problemsOf` in three files with two behaviors (one rethrows a non-`PermissionsError`, one
asserts on it). Target: `test/helpers.ts` in the runtime package.

### T2 [pin] — bench before and after R4, R5

**File:** `packages/graphql-casl/bench/hotpath.bench.ts`. The numbers are noisy (4-11%), so
compare several runs and treat only a clear regression as a stop.

---

## Docs

### D1 — doc comments attached to the wrong declaration

**File:** `applyPermissions.ts:807-834` The doc block for `resolvePermissions` sits above
the doc block for `validatePermissions`, so it attaches to nothing and
`resolvePermissions` (`:875`) has no doc in the generated API reference. `createCan.ts:48-53`
has the same fault for the internal `RuleIntrospection` type.

### D2 — small comment errors

**File:** `graphqlAbility.ts:73` (stray backtick); `combinators.ts:312-313` ("and ... and");
`@throws {@link PermissionsError}` in `applyPermissions.ts` versus `@throws {PermissionsError}`
in the same file and `validateGraphQLRules.ts`.

### D3 [sweep] — apply P4 (doc tags) across `src`

**Hits:** 43 `@param` and 12 `@returns` across about 114 module-level functions. Existing
tags already use the hyphen form.

---

## Bugs

### B1 — stored-rule validation accepts operators a leaf adapter rejects

**File:** `validateGraphQLRules.ts:61-78`, `conditions.ts:39-53`. `$not`, `$mod` and
`$options` pass `validateGraphQLRules` because CASL's matcher knows them, but
`accessibleBy` or `scopeArgs` with a leaf adapter throws on them per request. Is this
intended? If so a sentence in the validator's doc is enough; if not, an option to check
against the leaf list is a feature.

---

## API changes (need a decision)

### A1 — export vocabulary objects for the mode unions

`DenialMode`, `DenialReport`, `CacheMode`, `UnconditionedSubjectMode` and `OnDenyAll` are
types only. Exporting the constants from R14 is additive: a `feat:` commit, a minor release.

### A2 — export the wildcard key and an action guard

The directives package redefines `WILDCARD` (`src/index.ts:127`) and its own action set and
guard (`:167-173`); `validateGraphQLRules.ts:83` has a third action list. Additive, minor.
The directives peer range (`>=1.5.0`) would have to rise to the release that adds them.

---

## Low value

### R17 [consistency] — kebab-case filenames

About 40 renames. Subpath files (`scoping`, `envelop`, `apollo`, `index`) keep their names,
so nothing published moves. Costs `git blame` continuity and an `AGENTS.md` rewrite.

### R18 [consistency] — `.ts` import extensions

TypeScript 5.9 is installed, so `rewriteRelativeImportExtensions` is available. Touches
every import line.

### R19 [pattern] — domain folders (P21)

18 flat files today, about 23 after R1. Subpath entry points must stay at the `src/` root
for the `exports` map.

### D4 [sweep] — apply P19 (comment length)

Most public doc comments run 10 to 40 lines. They are the published API reference, written
that way on purpose; moving the body under `@remarks` keeps the text and meets the rule.

### D5 [sweep] — apply P5 (divider comments) in tests

**Hits:** 14, in `example.codegen.ts`, `directives.test.ts` and the two integration tests.

### T3 [consistency] — test files mirror source files

`test/permissions.test.ts` (921 lines) covers `rules.ts`, `createCan.ts` and `subjects.ts`.
