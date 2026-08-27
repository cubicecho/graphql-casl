# @vantreeseba/graphql-casl

A [`graphql-middleware`](https://github.com/dimagi/graphql-middleware) plugin for
defining [CASL](https://casl.js.org/) permission rules that apply to your GraphQL
resolvers. Declare rules per type/field in a `PermissionsMap`; each rule runs
before the underlying resolver and throws if the request is not allowed.

The library is **schema-agnostic** — the subject names and condition types are
derived from your own generated `Resolvers` / `ResolversTypes`, so there is no
manual type listing.

There are two optional entry points, neither of which the main one pulls in:

- `@vantreeseba/graphql-casl/scoping` for
  [scoping generated resolvers](#scoping-generated-resolvers-optional) — narrowing
  a field's filter argument instead of allowing or denying the field.
- `@vantreeseba/graphql-casl/envelop` for
  [enforcing the map through envelop](#enforcing-the-map-through-envelop-optional)
  instead of `graphql-middleware`.

## Install

```bash
npm install @vantreeseba/graphql-casl
# peer deps
npm install @casl/ability graphql graphql-middleware

# only if you import `@vantreeseba/graphql-casl/envelop`
npm install @envelop/core @envelop/on-resolve
```

`@envelop/core` and `@envelop/on-resolve` are *optional* peer dependencies, so npm
will not install them unless you ask for them. The package itself has no runtime
dependencies.

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
| `wrap` | Nests any rules as middleware, including ones the combinators reject. |
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
`Rule`, a `canUser.onResult(...)` rule and a `scopeArgs(...)` rule all reach
their verdict by running the resolver — one needs the resolved value, one
rewrites the arguments first — so none of them can be one branch of an `or`.
Passing one to a combinator throws **when the permissions map is built**, naming
the operand's position — never silently at request time.

`wrap(...rules)` is the way to compose those. It never asks an operand for a
verdict; it just nests them, so each receives the next as its `resolve` and the
last receives the real resolver:

```ts
Query: {
  // isNotBanned runs first; if it passes, the scoping rule narrows `where`
  notes: wrap(isNotBanned, scopeArgs(canUser, Actions.read, 'Note', { adapter })),
}
```

Order is left to right, outermost first, and a rule that never calls its
`resolve` stops there. `wrap` returns a plain `Rule`, never a combinable one —
a wrapper's verdict is only knowable by running it — so a `wrap` cannot itself
be an operand of `and` / `or` / `not` / `chain` / `race`. When every operand
*is* combinable, use `chain` instead: same meaning, no resolver nesting, and the
result stays combinable.

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
so the same map can be enforced through another integration — the envelop entry
point below, an Apollo plugin, hand-wrapped resolvers — with identical wildcard
precedence, `fallbackRule` coverage, error control and masking:

```ts
const permissionFor = resolvePermissions<Resolvers>(schema, permissions, options);

const rule = permissionFor(info.parentType.name, info.fieldName);
return rule
  ? rule(resolver, root, args, context, info)
  : resolver(root, args, context, info);
```

The map is validated up front exactly as `applyPermissions` validates it, and
lookups are memoized, so calling it per resolver call is cheap.

The envelop integration below is this pattern, already written.

### Enforcing the map through envelop (optional)

`applyPermissions` wraps a schema up front, which needs a schema you own and can
replace. That is awkward on Apollo Server 4+, on federated gateways, and anywhere
the schema is built or swapped for you. `useGraphQLCasl` hooks resolvers as
[envelop](https://the-guild.dev/graphql/envelop) hands them over, so the same map
works wherever envelop does: GraphQL Yoga, Apollo with the envelop integration,
Hive Gateway, `graphql-ws`.

```ts
import { createYoga } from 'graphql-yoga';
import { deny } from '@vantreeseba/graphql-casl';
import { useGraphQLCasl } from '@vantreeseba/graphql-casl/envelop';

const yoga = createYoga({
  schema,
  plugins: [
    useGraphQLCasl<Resolvers>({
      permissions,
      fallbackRule: deny,   // every option `applyPermissions` takes
      maskDenials: true,
    }),
  ],
});
```

`options.permissions` is the map; every other key is an
[`ApplyPermissionsOptions`](#error-control) field. Wildcard precedence,
`fallbackRule` coverage, error control and masking all behave exactly as they do
under `applyPermissions` — the plugin calls `resolvePermissions` rather than
reimplementing any of it. Beyond that:

- **The map is validated when the schema arrives**, not on the first query that
  touches the offending field, so a map naming a type or field the schema does
  not have throws a `PermissionsError` while the server is being built. A schema
  swapped at runtime is re-validated and re-resolved.
- **Introspection is never guarded**, even under `fallbackRule: deny`.
- **A field with no resolver of its own is guarded too** — the default resolver
  is wrapped like any other, which is what makes a `canUser.fields(...)` rule on
  a plain object type work.
- **Each field is wrapped once**, however many times it resolves.

| | `applyPermissions` | `useGraphQLCasl` |
|---|---|---|
| Mechanism | wraps the schema via `graphql-middleware` | wraps resolvers via envelop |
| Needs a schema you can replace | yes | no |
| Works outside envelop | yes | no |
| Dynamic / swapped schemas | re-wrap yourself | handled |

Use one or the other, not both — two layers would run every rule twice.

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

That adapter is a *skeleton* adapter: it replaces the boolean operators and
passes each rule's conditions through as written, so a rule using
`{ status: { $in: [...] } }` still emits `$in` inside a Prisma-shaped tree.

When the target dialect spells its comparisons differently, supply `leaf`
instead of `rule` and the conditions are walked for you — one comparison at a
time, with dotted keys already split into a path:

```ts
const sqlishFilter: FilterAdapter<object> = {
  leaf: ({ path, operator, value }) => {
    const op = { $eq: 'eq', $ne: 'ne', $in: 'inArray', $gt: 'gt' }[operator];
    if (!op) throw new Error(`unsupported in this dialect: ${operator}`);
    return { [path.join('.')]: { [op]: value } };
  },
  not: (filter) => ({ NOT: filter }),
  and: (filters) => ({ AND: filters }),
  or: (filters) => ({ OR: filters }),
  everything: () => ({}),
};
```

A leaf adapter must throw on an operator it cannot express — the walker does the
same for one it does not know. Dropping a clause would silently *widen* access,
which is the one failure mode a filter must never have.

That example assumes the dialect has `AND`, `OR` and `NOT` keys to map onto.
Several generated ones do not. drizzle-graphql's `<Table>Filters` has **no `AND`
and no `NOT`**: column entries are implicitly ANDed, there is exactly one `OR`,
`OR` does not nest, and a filter carrying both column entries and an `OR` is a
runtime error. That input type accepts disjunctive normal form and nothing else,
so an adapter for it has to distribute `and` over `or` and push `not` down to
the leaves with De Morgan. [`test/recipes/drizzleGraphql.ts`][drizzle-recipe] is
a worked, tested one — copy it rather than writing the four-line version above
and discovering at the data layer that the scope was ignored.

[drizzle-recipe]: ./test/recipes/drizzleGraphql.ts

CASL evaluates rules in priority order and stops at the first match; a query has
no such ordering. Each `can` therefore becomes an `$or` branch bounded by the
`cannot`s that outrank it, which is why the output nests more than the rules
suggest. Field-level rules are ignored — this answers which *rows* are reachable.

### Scoping generated resolvers (optional)

`accessibleBy` needs a resolver you can edit. Generated CRUD resolvers —
drizzle-graphql, Prisma-based generators, Hasura-style layers — give you no such
seam: `Query.notes(where:)` is written for you, and the only thing you control
from the outside is its arguments.

`scopeArgs` closes that gap. It folds the caller's ability into a filter and
**rewrites the field's arguments** before the resolver runs, ANDing the scope
onto whatever filter the client sent:

```ts
import { scopeArgs } from '@vantreeseba/graphql-casl/scoping';

const permissions = {
  Query: {
    notes: scopeArgs(canUser, Actions.read, 'Note', {
      adapter: drizzleFilters({ nonNullColumn: 'id' }),
    }),
  },
} satisfies PermissionsMap<Resolvers>;
```

A caller who may read `{ userId: 'alice' }` notes gets
`where: { userId: { eq: 'alice' } }`; one who sends their own
`where: { status: { eq: 'live' } }` gets both, ANDed. A caller the ability
restricts not at all has their arguments left untouched.

It is a separate entry point, so nothing about it is loaded — or has to be
understood — unless you import it.

| Option | Default | |
| --- | --- | --- |
| `adapter` | *(required)* | The dialect to fold into. Skeleton or leaf. |
| `into` | `'where'` | The argument to inject the filter into. |
| `merge` | `adapter.and([client, scope])` | How to combine the caller's own filter with the scope. |
| `onDenyAll` | `'deny'` | `'deny'` throws `Forbidden`; `'nothing'` injects `adapter.nothing()` so the field resolves empty. |

Four things to know before reaching for it:

- **A scoped field returns fewer rows, not an error.** That is the point, but a
  caller cannot tell "no such row" from "not yours". `onDenyAll: 'deny'` is the
  default so at least the all-or-nothing case is honest.
- **Injected arguments bypass GraphQL's input coercion.** Rules run *downstream*
  of validation, so a filter in the wrong dialect is not rejected — it reaches
  the data layer as written, where it may be ignored and quietly leave the field
  unscoped. `applyPermissions` checks that `into` names a real argument of the
  field; matching the *shape* to the input type is on you, so test it.
- **Don't merge by spreading keys.** The default merge is a top-level `AND` for
  a reason: a client filter of `{ OR: [...] }` sits *beside* a spread-in scope
  rather than under it, and the scope stops applying. Override `merge` only when
  the dialect needs a different combining shape.
- **A scoping rule is not a gate.** It says nothing about the fields around it,
  and it cannot be an operand of `and` / `or` / `not` / `chain` / `race` — it
  decides by rewriting arguments and calling the resolver. Pair it with
  `fallbackRule`, or put a gate in front of it with `wrap(isNotBanned, scoped)`.
  `wrap` also stacks scoping with `onResult`, so a field can be narrowed *and*
  have the rows it returns re-checked.

On a mutation, scoping narrows the rows the mutation touches — `archiveNotes`
archives only your own. Note the asymmetry with `onResult`, which refuses
mutations outright: scoping happens *before* the resolver, so nothing has
happened yet when it decides. Keep `onDenyAll: 'deny'` there, though: a
forbidden delete should fail, not succeed while matching nothing.

### Delegating to an external policy engine

CASL conditions are evaluated against the subject's own attributes, so they
express "your own note" well and *relationship-derived* permissions — "any
document in a folder you own", "anything your team's role inherits" — not at
all. Those are the shape [OpenFGA][openfga], [Cerbos][cerbos], [OPA][opa] and
[Oso][oso] exist for.

Nothing needs to change to reach one. A check is an ordinary async function, so
it can ask a policy decision point and return the answer:

```ts
import { rule } from '@vantreeseba/graphql-casl';

const askOpenFga = rule(
  async (_parent, args: { id: string }, ctx: Context) =>
    (await ctx.fga.check({
      user: `user:${ctx.user.id}`,
      relation: 'editor',
      object: `note:${args.id}`,
    })).allowed || 'You do not have edit access to this note',
  { name: 'askOpenFga' },
);
```

Because it is a rule like any other, it composes with the ability-backed ones.
Put it last in a `chain` so a cheap local check can deny before the network call
happens at all:

```ts
Mutation: {
  archive: chain(isNotBanned, canUser(Actions.delete, Subject.Note), askOpenFga),
}
```

Two things are worth being deliberate about.

**A PDP outage is not a denial.** If the check *throws*, the error propagates
unchanged instead of becoming `Forbidden` — that is the intended behaviour here,
and it is why the example returns a string on a negative decision rather than
throwing on both. Never `catch` and return `false`: that reports an unreachable
authorization service as "you may not", which is indistinguishable from a real
verdict in your logs and hides the outage. `maskDenials` respects the same line
and will not mask it.

**Cache the decision per request.** One query can touch the same object dozens
of times, and each one is a round trip. Memoize on the context the way the
ability itself is memoized:

```ts
function checkOnce(ctx: Context, key: string, ask: () => Promise<boolean>) {
  const pending = ctx.pdpCache.get(key) ?? ask();
  ctx.pdpCache.set(key, pending); // a Map created per request
  return pending;
}
```

Cache the *pending promise*, not the resolved value, so concurrent sibling
fields share one call rather than starting several.

For list fields, a PDP with a "list objects the user can access" endpoint plays
the role [`accessibleBy`](#row-level-filtering) plays for CASL rules: fetch the
allowed ids first and filter the query, rather than resolving rows and denying
them one by one.

[openfga]: https://openfga.dev
[cerbos]: https://cerbos.dev
[opa]: https://www.openpolicyagent.org
[oso]: https://www.osohq.com

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

## Coming from `graphql-shield`

Both libraries occupy the same slot — a `graphql-middleware` layer keyed by type
and field — so the map you already have mostly transfers. What changes is the
rule *body*: shield rules are opaque predicates, and the point of this library is
that a rule's subject, action and conditions are checked against your schema.

```ts
// shield
const schema = applyMiddleware(baseSchema, shield(permissions, options));

// here
const schema = applyPermissions<Resolvers>(baseSchema, permissions, options);
```

| `graphql-shield` | Here |
| --- | --- |
| `rule(name, opts)(async (parent, args, ctx, info) => …)` | `rule(check, { name })` — same arguments, same `true` / `false` / `string` / `Error` return contract |
| `and` / `or` / `not` / `chain` / `race` | same names, same semantics: `and`/`or` evaluate in parallel, `chain`/`race` short-circuit, `not(rule, error?)` |
| — | `wrap(...rules)` has no shield equivalent: it nests rules as middleware, so rules that decide by running the resolver can still be composed |
| `allow` / `deny` | `accept` / `deny` |
| `fallbackRule: deny` | same option |
| `'*'` field key | `'*'` in **either** position, with [documented precedence](#wildcards) |
| `shield(someRule)` — one rule for the whole schema | `fallbackRule`, or `{ '*': someRule }` |
| `fallbackError` | same option — but it replaces only denials that did not name their own error |
| `allowExternalErrors` | same option, **opposite default** — see below |
| `debug` | same option |
| `ValidationError` for a rule on a field the schema lacks | `PermissionsError`, aggregating *every* problem in the map rather than the first |
| `cache: 'contextual' \| 'strict'` per rule | no equivalent; `createCan` memoizes `getAbility(context)` per request instead |
| `inputRule` (yup-backed argument validation) | no equivalent — validate arguments in a `rule()` check or in the resolver |
| `rule({ fragment })` | not supported, deliberately — see [the note below](#three-differences-that-will-bite) |

### Three differences that will bite

**`allowExternalErrors` defaults to `true` here, `false` in shield.** Shield
masks an error thrown by your resolver behind the fallback error; this library
lets it reach the client. Neither default is wrong, but they are opposites, so a
map ported verbatim changes what your clients see on an internal failure. Set
`allowExternalErrors: false` to match shield.

**`deny` rejects rather than throwing synchronously.** Every rule built by
`rule()` is async. Under `graphql-middleware` — which awaits — the two are
equivalent; a test that calls a rule directly and expects a synchronous throw is
not.

**There is no `fragment` option.** Shield's forces the fields a rule reads into
the parent's selection set. `graphql-middleware` extracts a rule's `fragment`
into a `fragmentReplacements` array that only graphql-tools *delegation* reads —
under plain execution the selection set is unchanged. Shipping the option would
promise a guarantee it cannot keep, so a parent-aware rule documents the
projecting-resolver caveat instead. See
[Field-level rules](#field-level-rules).

### What the port is for

A shield rule answers "may this caller run this resolver". Once ported, the same
map can answer "may this caller do this *to this record*":

```ts
// shield: the predicate is opaque, and the id comes from the client
const isNoteOwner = rule()(async (_parent, args, ctx) =>
  (await db.notes.findById(args.id)).userId === ctx.user.id,
);

// here: one ability rule covers every note check in the schema
can(Actions.update, Subject.Note, { userId: ctx.user.id });

Mutation: {
  updateNote: canUser.onResult(Actions.update, Subject.Note),
}
```

`Subject.Note` and `userId` are checked against your schema at compile time, the
rule is plain JSON so it can live in a database, and
[`onResult`](#post-execution-rules) evaluates the condition against the record
the resolver actually returned rather than the id the client asserted.

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
