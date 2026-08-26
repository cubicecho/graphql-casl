# @vantreeseba/graphql-casl

A [`graphql-middleware`](https://github.com/dimagi/graphql-middleware) plugin for
defining [CASL](https://casl.js.org/) permission rules that apply to your GraphQL
resolvers. Declare rules per type/field in a `PermissionsMap`; each rule runs
before the underlying resolver and throws if the request is not allowed.

The library is **schema-agnostic** — the subject names and condition types are
derived from your own generated `Resolvers` / `ResolversTypes`, so there is no
manual type listing.

## Install

```bash
npm install @vantreeseba/graphql-casl
# peer deps
npm install @casl/ability graphql graphql-middleware
```

## Concepts

| Export | What it does |
|---|---|
| `createGraphQLAbility<SubjectMap>()` | Returns a CASL `AbilityBuilder` typed against your schema — `can`/`cannot` conditions are checked against each subject's fields — with `__typename` detection applied by `build()`. |
| `buildGraphQLAbility<SubjectMap>(rules, options?)` | Rebuilds an ability from stored `GraphQLRule`s (e.g. rules persisted in a database and loaded at startup). |
| `createCan(getAbility, isAuthenticated, buildSubject?)` | Factory that returns a `requireCan(action, subject, getSubjectData?)` rule builder, bound to your context shape and ability builder. `requireCan.onResult(...)` authorizes the resolved value instead of the args. |
| `createTyped<SubjectMap>()` | Returns a `typed(type, attrs)` helper that tags plain objects with `__typename` for subject detection. |
| `createSubjects<SubjectMap>()` | Validates a subject-name const object against your schema's domain types. |
| `accept` / `deny` | Always-pass / always-fail rule primitives. |
| `Actions` | Const map of `create` / `read` / `update` / `delete` / `manage`. |

Type helpers: `PermissionsMap`, `Rule`, `SubjectName`, `SubjectMap`, `ArgsOf`,
`ParentOf`, `ContextOf`, `Action`, `GraphQLAbility`, `GraphQLAbilities`,
`GraphQLRule`, `GraphQLAbilityOptions`, `AbilityLike`.

A failed authentication check throws `Not authenticated`; a failed ability check
throws `Forbidden`.

### Conditions

`GraphQLAbility` is a CASL [`MongoAbility`](https://casl.js.org/v6/en/guide/conditions-in-depth),
so conditions use the standard CASL mongo-query operators. A field maps to either
a bare value (equality) or an operator object:

```ts
can('read', 'Note', { userId });                          // equality
can('read', 'Note', { status: { $in: ['draft', 'live'] } });
can('read', 'Note', { version: { $gt: 2 }, title: { $ne: '' } });
```

Operators are CASL's mongo set (`$eq`, `$ne`, `$in`, `$nin`, `$gt`, `$gte`,
`$lt`, `$lte`, …). Conditions are plain JSON, so you can store rules in a database
and rehydrate with `buildGraphQLAbility` (see [Persisting rules](#5-persisting-rules-optional)).

## Usage

### 1. Build abilities

Bind the generic helpers to your app's generated types and define abilities with
`createGraphQLAbility`. It returns a CASL `AbilityBuilder` typed against your
`SubjectMap`, so `can`/`cannot` conditions are checked against each subject's
fields, and `build()` wires `__typename` subject detection for you.

```ts
import {
  Actions,
  createGraphQLAbility,
  createSubjects,
  createTyped,
  type GraphQLAbility,
  type SubjectMap,
} from '@vantreeseba/graphql-casl';
import type { Resolvers, ResolversTypes } from './__generated__/resolvers.js';

export type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;
export type AppAbility = GraphQLAbility<AppSubjectMap>;

export const typed = createTyped<AppSubjectMap>();
export const Subject = createSubjects<AppSubjectMap>()({
  User: 'User',
  Note: 'Note',
} as const);

export function defineAbilitiesFor(userId: string | undefined): AppAbility {
  const { can, build } = createGraphQLAbility<AppSubjectMap>();
  if (!userId) return build(); // no rules ⇒ everything denied
  can(Actions.read, Subject.Note);
  can(Actions.update, Subject.Note, { userId }); // typed against Note's fields
  return build();
}
```

### 2. Bind `createCan` to your context

```ts
import { createCan } from '@vantreeseba/graphql-casl';
import type { Context } from './context.js';
import { type AppSubjectMap, defineAbilitiesFor, typed } from './abilities.js';

const canUser = createCan<Context, AppSubjectMap>(
  async (ctx) => defineAbilitiesFor(ctx.userId),
  (ctx) => ctx.userId != null,
  typed,
);
```

### 3. Declare the permissions map

`getSubjectData` builds the subject instance from the resolver args; the subject
name narrows its return to that subject's fields, so annotate `args` with your
generated `*Args` type to type the extraction end to end. Without it the rule
checks against the bare subject type.

```ts
import { accept, deny, type PermissionsMap } from '@vantreeseba/graphql-casl';
import type { Resolvers, MutationUpdateNoteArgs } from './__generated__/resolvers.js';

export const permissions: PermissionsMap<Resolvers> = {
  Query: {
    note: canUser(Actions.read, Subject.Note),
    me: canUser(Actions.read, Subject.User),
  },
  Mutation: {
    requestMagicLink: accept, // public
    deleteNotes: deny,        // nobody, ever
    updateNote: canUser(Actions.update, Subject.Note, (args: MutationUpdateNoteArgs) => ({
      userId: args.userId,
    })),
  },
};
```

> ⚠️ **Checks run before the resolver.** `graphql-middleware` invokes a rule
> *before* the field resolver, so `getSubjectData` only sees `args`/`context` —
> never the to-be-loaded entity. A condition built from a client-supplied arg
> (`args.userId`) therefore validates what the **client asserted**, not the real
> record. If the resolver then targets a *different* arg (e.g. `args.id`), a
> caller can pass their own `userId` (to pass the check) but someone else's `id`
> — an IDOR. Use [`canUser.onResult`](#post-execution-rules) to authorize the
> record the resolver actually loaded, make the resolver **scope by the same
> field the rule authorized** (look up by `id` **and** `userId`), derive the
> owner from `context` rather than args, or enforce ownership in your data layer.

> ⚠️ **A bare subject name does not evaluate conditions.**
> `ability.can('update', 'Note')` asks CASL whether updating a Note is *possible
> at all*, not whether it is permitted on a particular one. Given
> `can('update', 'Note', { userId })`, the bare check returns `true` for every
> caller. Omitting `getSubjectData` there is not a type error, so `createCan`
> detects it at request time and warns once per rule; pass
> `{ onUnconditionedSubject: 'throw' }` to make it a denial, or `'allow'` when the
> possibility check is deliberate (a list field whose rows you filter inside the
> resolver).

### Post-execution rules

`canUser.onResult` runs the resolver first and checks the ability against **what
it returned**, so conditions are evaluated on the real record rather than on what
the client asserted. This is the direct fix for the IDOR shape above.

```ts
export const permissions: PermissionsMap<Resolvers> = {
  Query: {
    // authorizes the Note the resolver actually loaded, not args.id
    note: canUser.onResult(Actions.read, Subject.Note),
  },
};
```

The resolved value is the subject data by default. Pass a `getSubjectData` to
unwrap it or to authorize a projection; it receives each candidate individually,
so a list calls it once per element.

```ts
notes: canUser.onResult(Actions.read, Subject.Note, (row: NoteRow) => ({
  userId: row.ownerId,
})),
```

Semantics worth knowing:

- **Lists are all-or-nothing.** Every element must pass or the whole field is
  denied. Filtering a list down to the permitted rows is a different operation.
- **`null` passes through.** There is no subject to authorize.
- **A tagger is required.** `onResult` needs `buildSubject` on `createCan` —
  resolved rows carry no `__typename`, so without it CASL cannot classify them.
  Calling `onResult` without one throws when the map is built, not at request time.

> ⚠️ **The resolver runs before the check.** That is inherent — the check needs
> the result — so this form is unsuitable for anything with side effects. A rule
> built with `onResult` therefore **refuses to guard a root mutation field**, and
> refuses it *before* calling the resolver, so the mutation never happens. For
> mutations, check the arguments up front with `canUser(...)`, or write a `Rule`
> by hand. Side-effecting *queries* (view counters and the like) are not detected
> — the same caution applies to them.

### 4. Apply to the schema

```ts
import { applyPermissions } from '@vantreeseba/graphql-casl';

const schemaWithPermissions = applyPermissions<Resolvers>(schema, permissions);
```

`applyPermissions` keeps `permissions` typed as a `PermissionsMap<Resolvers>`, so
a mistyped type or field name is caught at compile time. It also re-checks the map
against the runtime schema and throws a `PermissionsError` listing **every**
problem at once — which is what catches rules loaded from a database, written in
plain JavaScript, or built against a schema that has since drifted.

Entries that would be silently inert are rejected rather than ignored: a rule on
an interface or union type never runs (fields resolve against the concrete object
type), and introspection types cannot be guarded. In an authorization library, a
rule that quietly never runs is the worst failure mode, so it is an error.

Types not named in the map are left **unguarded** — the map is a whitelist of what
to guard, not a schema-coverage guarantee. Pass `fallbackRule` to invert that, so a
field added to the schema later ships protected rather than open:

```ts
const schema = applyPermissions<Resolvers>(baseSchema, permissions, {
  fallbackRule: deny, // deny by default; the map is now the allow-list
});
```

Introspection is never guarded, so `fallbackRule: deny` does not break it.

> **Note:** the "deny by default" that CASL gives you is about *abilities* — an
> action with no matching rule is denied. That is a different guarantee from
> *schema coverage*, which is what `fallbackRule` provides. You want both.

### Wildcards

`'*'` works in either position. Wildcards never compose: exactly one rule guards a
field, and the most specific entry wins.

```ts
const permissions: PermissionsMap<Resolvers> = {
  Note: { '*': canUser(Actions.read, Subject.Note), id: accept },
  '*': { createdAt: deny },
};
```

From highest precedence to lowest:

| Entry | Matches |
| --- | --- |
| `{ Note: { body: rule } }` | a named field of a named type |
| `{ Note: { '*': rule } }` or `{ Note: rule }` | any field of a named type |
| `{ '*': { body: rule } }` | a named field of any type |
| `{ '*': { '*': rule } }` or `{ '*': rule }` | any field of any type |
| `fallbackRule` | everything else |

Field names under `'*'` are still checked — against every field in the schema, so a
typo that matches no type at all is an error.

### 5. Persisting rules (optional)

Rules are plain JSON, so they can be stored in a database and loaded/cached at
startup. Read `builder.rules` (or `ability.rules`) to persist them, and rebuild
with `buildGraphQLAbility`:

```ts
import { buildGraphQLAbility, type GraphQLRule } from '@vantreeseba/graphql-casl';

// persist
const { can, build } = createGraphQLAbility<AppSubjectMap>();
can(Actions.update, Subject.Note, { userId });
await db.savePermissionRules(build().rules);

// load (per request or cached)
const rules: GraphQLRule<AppSubjectMap>[] = await db.loadPermissionRules();
const ability = buildGraphQLAbility<AppSubjectMap>(rules);
```

## Development

```bash
npm install
npm test        # run vitest
npm run coverage # run vitest with coverage
npm run typecheck # tsc --noEmit
npm run build   # compile to dist/
npm run check   # biome lint + format check
npm run docs    # generate the Markdown API reference into docs/api/
```

## API reference

Every export carries JSDoc. Generate a full Markdown API reference with
[TypeDoc](https://typedoc.org/) + the Markdown plugin:

```bash
npm run docs   # writes docs/api/ (git-ignored)
```

The docs are not committed; CI builds them and publishes them to this
repository's [GitHub Wiki](../../wiki) on every push to `main`.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) and
drive automated releases: pushes to `main` run the **Test** workflow, and on
success the **Release** workflow runs [semantic-release](https://semantic-release.gitbook.io/)
to version, changelog, publish to npm, and tag a GitHub release.

See [TODO.md](./TODO.md) for deferred work.

## License

[MIT](LICENSE) © Benjamin Van Treese
