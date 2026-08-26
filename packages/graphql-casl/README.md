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
| `createCan(getAbility, isAuthenticated, buildSubject?)` | Factory that returns a `requireCan(action, subject, getSubjectData?)` rule builder, bound to your context shape and ability builder. `requireCan.onResult(...)` authorizes the resolved value instead of the args; `requireCan.fields(...)` guards every field of a type from the ability's field lists. |
| `createTyped<SubjectMap>()` | Returns a `typed(type, attrs)` helper that tags plain objects with `__typename` for subject detection. |
| `createSubjects<SubjectMap>()` | Validates a subject-name const object against your schema's domain types. |
| `rule(check, opts?)` | Wraps a predicate into a rule that is also combinable. |
| `and` / `or` / `not` / `chain` / `race` | Combinators over combinable rules. |
| `accept` / `deny` | Always-pass / always-fail rule primitives. |
| `resolvePermissions(schema, permissions, options?)` | The permission layer without the `graphql-middleware` binding: a per-field rule lookup for building another integration. |
| `accessibleBy(ability, action, subject, adapter?)` | Folds the ability into a query filter for row-level filtering, or `null` for deny-all. |
| `Actions` | Const map of `create` / `read` / `update` / `delete` / `manage`. |

Type helpers: `PermissionsMap`, `Rule`, `CheckableRule`, `Check`, `RuleResult`,
`SubjectName`, `SubjectMap`, `ArgsOf`, `ParentOf`, `ContextOf`, `Action`,
`GraphQLAbility`, `GraphQLAbilities`, `GraphQLRule`, `GraphQLAbilityOptions`,
`AbilityLike`, `AccessibleFilter`, `FilterAdapter`, `PermissionResolver`.

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

### Field-level rules

A `PermissionsMap` key can be any type, not just `Query`/`Mutation`, so rules
attach to individual fields. A field rule's condition usually belongs to the
*parent* — "read `User.email` only when it's your own user" says nothing about
the field's args — so `getSubjectData` receives `parent` as its second argument:

```ts
import type { ParentOf } from '@vantreeseba/graphql-casl';
import type { UserResolvers } from './__generated__/resolvers.js';

export const permissions: PermissionsMap<Resolvers> = {
  User: {
    email: canUser(
      Actions.read,
      Subject.User,
      (_args, parent: ParentOf<UserResolvers['email']>) => ({ id: parent.id }),
    ),
  },
};
```

`parent` is additive — existing single-argument extractors are unaffected.

> ⚠️ **If your resolvers project by selection set, select what your rules read.**
> Under plain `graphql-js` execution a parent resolver returns its whole object,
> so a field rule reliably sees the fields it conditions on. That stops being
> true when the parent resolver narrows by `info` — a Prisma `select` built from
> the selection set, or schema delegation — because a field the client didn't
> request may be absent, and an absent field makes a CASL condition *fail*
> rather than error. Nothing can fix that from inside a rule: the parent has
> already resolved by the time a field rule runs. `graphql-middleware`'s
> `fragment` option does not help either — it populates a `fragmentReplacements`
> array for graphql-tools delegation and never reaches plain execution. Have the
> parent resolver select the fields your rules condition on.

### Field permissions from the ability

CASL rules already carry field lists — `can('read', 'User', ['id', 'name'])`.
Restating those as one `PermissionsMap` entry per field duplicates them, and the
two drift. `canUser.fields` attaches a single rule to a type and decides each
field from the ability:

```ts
// abilities
can(Actions.read, Subject.User, ['id', 'name']);
can(Actions.read, Subject.User, ['email'], { id: userId }); // only your own

// permissions map — one entry, every field of User guarded
export const permissions: PermissionsMap<Resolvers> = {
  Query: { me: canUser(Actions.read, Subject.User) },
  User: canUser.fields(Actions.read, Subject.User),
};
```

The subject is the resolver's `parent` — for a field of `User` that is the `User`
being read, which is what a field-level condition is about. Pass `getSubjectData`
to project it. On a root field, where there is no parent, the check degrades to
the bare subject name: "is this field readable at all".

Unlike the rest of the map, this is **deny-by-default across the type's fields**:
a field no ability rule mentions is denied rather than left unguarded. A
`buildSubject` tagger is required, since the parent carries no `__typename`.

### Combining rules

`rule(check)` turns a predicate into a rule. A check returns `true` to allow,
`false` to deny with `Forbidden`, a `string` to deny with that message, or an
`Error` to throw as-is — so it can carry a `GraphQLError` with a code and
extensions:

```ts
import { rule } from '@vantreeseba/graphql-casl';

const isNotBanned = rule(
  (_parent, _args, ctx: Context) => !ctx.user?.banned || 'Your account is suspended',
  { name: 'isNotBanned' },
);
```

An error raised *inside* a check propagates unchanged rather than becoming a
denial, so a broken check is never mistaken for a legitimate `Forbidden`.

Rules built by `rule()` or `createCan(...)`, plus `accept` and `deny`, are
**combinable**: their verdict can be asked for without running the resolver, so
they work as operands of the combinators.

| Combinator | Passes when | Evaluation | Error on failure |
| --- | --- | --- | --- |
| `and(...rules)` | every operand passes | parallel, all evaluated | the **first** failing operand's |
| `chain(...rules)` | every operand passes | sequential, stops at first failure | the failing operand's |
| `or(...rules)` | any operand passes | parallel, all evaluated | the **last** operand's |
| `race(...rules)` | any operand passes | sequential, stops at first pass | the **last** operand's |
| `not(rule, error?)` | the operand fails | — | `error`, else `Forbidden` |

```ts
Mutation: {
  publish: and(canUser(Actions.update, Subject.Note), isNotBanned),
  // askOpenFga only runs once the cheap checks have passed
  archive: chain(isNotBanned, canUser(Actions.delete, Subject.Note), askOpenFga),
}
```

Combinators return combinable rules, so they nest.

Two kinds of rule coexist, and only one is combinable. A hand-written middleware
`Rule` and a `canUser.onResult(...)` rule both need to run the resolver to reach
a verdict, so they cannot be one branch of an `or`. Passing one to a combinator
throws **when the permissions map is built**, naming the operand's position —
never silently at request time.

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

### Error control

By default a denial throws `Error('Forbidden')`, which carries no code and tells
a client nothing it can act on. Three options on `applyPermissions` change that:

```ts
const schema = applyPermissions<Resolvers>(baseSchema, permissions, {
  fallbackError: (_err, _parent, _args, _ctx, info) =>
    new GraphQLError(`Not authorized to read ${info.parentType.name}.${info.fieldName}`, {
      extensions: { code: 'FORBIDDEN' },
    }),
  allowExternalErrors: false, // mask resolver errors behind the fallback
  debug: process.env.NODE_ENV !== 'production', // surface broken rules as themselves
});
```

`fallbackError` takes an `Error`, a message, or a mapper. It replaces only
denials that did not name their own error. A check that returned a string or an
`Error`, and a CASL `cannot(...).because('...')` reason, both survive it — the
rule author was specific on purpose.

Three failures reach a client as errors and the options treat them differently:

| Failure | Default | Option |
| --- | --- | --- |
| **Denial** — the rule did its job | `Forbidden` | `fallbackError` |
| **Resolver error** — the field was allowed, the resolver failed | reaches the client verbatim | `allowExternalErrors: false` masks it |
| **Rule failure** — `getAbility` threw, a check has a bug | reported as a denial | `debug: true` rethrows it untouched |

A fourth option, `maskDenials`, removes the denial from the response entirely
rather than rewording it — see [Masking denials](#masking-denials) below.

> **Note for `graphql-shield` users:** `allowExternalErrors` defaults to `true`
> here, the opposite of shield, which masks resolver errors by default. Masking
> is the safer behaviour, but it is not what this library has done since 1.0 and
> silently swallowing resolver errors on upgrade would be worse than leaving the
> choice explicit. Set it to `false` deliberately.

#### Masking denials

A thrown denial propagates up the non-null chain. Deny one field of
`todos: [Todo!]!` and the *whole* `data` payload becomes `null` — an
unauthorized corner of a query destroys the authorized rest of it.
`maskDenials` resolves a denied field to an empty value instead:

```ts
const schema = applyPermissions<Resolvers>(baseSchema, permissions, {
  maskDenials: true,
});
```

| Field | Denied result |
| --- | --- |
| `me: User` | `null` |
| `todos: [Todo!]` | `null` |
| `todos: [Todo!]!` | `[]` |
| `id: ID!` | still throws — no value satisfies it |

The response carries no error at all, so "you may not read this" and "this does
not exist" become indistinguishable. That is the point when the existence of a
record is itself privileged, and a support burden otherwise.

Only *denials* are masked. A rule that threw a bug of its own, and a resolver
that failed on a permitted field, both still surface their errors — silently
nulling those would hide an outage as a permission decision.

#### Denial reasons from CASL

A `cannot(...).because('...')` reason becomes the denial message:

```ts
can(Actions.update, Subject.Note, { userId });
cannot(Actions.update, Subject.Note, { locked: true }).because('That note is locked');
```

A caller updating a locked note of their own gets `That note is locked`;
everything else still gets `Forbidden`. CASL's own `ForbiddenError` would default
to `Cannot execute "update" on "Note"`, which tells an unauthorized caller a type
name, so the reason is read off the matched rule instead.

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

### Using the map without `graphql-middleware`

`applyPermissions` is `resolvePermissions` plus `graphql-middleware`.
`resolvePermissions` stops one step earlier and hands back the per-field lookup,
so the same map can be enforced through another integration — an envelop plugin,
an Apollo plugin, hand-wrapped resolvers — with identical wildcard precedence,
`fallbackRule` coverage, error control and masking:

```ts
const permissionFor = resolvePermissions<Resolvers>(schema, permissions, options);

const rule = permissionFor(info.parentType.name, info.fieldName);
return rule
  ? rule(resolver, root, args, context, info)
  : resolver(root, args, context, info);
```

The map is validated up front exactly as `applyPermissions` validates it, and
lookups are memoized, so calling it per resolver call is cheap.

### Row-level filtering

A rule is a gate: it allows or denies a whole field. That is the wrong shape for
a list — `notes` should not be denied outright because one row is off-limits.
`accessibleBy` folds the ability's rules for one action and subject into a query
filter, so the rows the caller may not read are never fetched:

```ts
import { accessibleBy, Actions } from '@vantreeseba/graphql-casl';

const resolvers = {
  Query: {
    notes: async (_parent, _args, ctx) => {
      const filter = accessibleBy(await ctx.ability, Actions.read, 'Note');
      if (filter === null) return []; // nothing is accessible
      return db.notes.find(filter);
    },
  },
};
```

`null` is a decision, not an absence: it means *deny all*. Every other value —
including `{}`, which means "no restriction" — is a filter to pass on.

The default dialect is mongo-shaped, matching the operators CASL conditions are
already written in. A `FilterAdapter` swaps the boolean skeleton for another:

```ts
const prismaFilter: FilterAdapter<object> = {
  rule: (conditions, inverted) => (inverted ? { NOT: conditions } : conditions),
  and: (filters) => ({ AND: filters }),
  or: (filters) => ({ OR: filters }),
  everything: () => ({}),
};

const where = accessibleBy(ability, Actions.read, 'Note', prismaFilter);
return where === null ? [] : prisma.note.findMany({ where });
```

> ⚠️ The adapter controls the boolean skeleton, **not the leaves**. Conditions
> are passed through as written, so a rule using `{ status: { $in: [...] } }`
> still emits `$in` inside a Prisma-shaped tree. Write conditions in the target
> dialect's terms, or translate them in `rule`.

CASL evaluates rules in priority order and stops at the first match; a query has
no such ordering. Each `can` therefore becomes an `$or` branch bounded by the
`cannot`s that outrank it, which is why the output nests more than the rules
suggest. Field-level rules are ignored — this answers which *rows* are reachable.

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
