# @vantreeseba/graphql-casl

A [`graphql-middleware`](https://github.com/maticzav/graphql-middleware) plugin for
defining [CASL](https://casl.js.org/) permission rules that apply to your GraphQL
resolvers. Declare rules per type/field in a `PermissionsMap`; each rule runs
before the underlying resolver and throws if the request is not allowed.

The library is **schema-agnostic** — the subject names and condition types are
derived from your own generated `Resolvers` / `ResolversTypes`, so there is no
manual type listing.

There are three optional entry points, none of which the main one pulls in:

- `@vantreeseba/graphql-casl/scoping` for
  [scoping generated resolvers](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/scoping.md) — narrowing
  a field's filter argument instead of allowing or denying the field.
- `@vantreeseba/graphql-casl/envelop` for
  [enforcing the map through envelop](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/envelop.md)
  instead of `graphql-middleware`.
- `@vantreeseba/graphql-casl/apollo` for
  [reporting filtered denials on Apollo Server](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/error-control.md#where-filtered-denials-are-reported)
  — the one response hook `applyPermissions` cannot reach on its own.

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
dependencies. The `/apollo` entry point needs nothing extra — it is typed against
the shape of Apollo Server's plugin contract, not against `@apollo/server`.

### Generating the types

Every type helper is keyed off your schema's generated `Resolvers` /
`ResolversTypes` — that is where subject names and condition fields come from,
and it is why a typo'd type or field name is a compile error rather than a rule
that silently never matches. Generate them with
[GraphQL Code Generator](https://the-guild.dev/graphql/codegen):

```ts
// codegen.ts
import type { CodegenConfig } from '@graphql-codegen/cli';

export default {
  schema: './schema.graphql',
  generates: {
    'src/__generated__/resolvers.ts': {
      plugins: [
        'typescript',
        'typescript-resolvers',
        '@vantreeseba/graphql-casl-codegen', // optional, see below
      ],
    },
  },
} satisfies CodegenConfig;
```

`typescript` + `typescript-resolvers` are all this library requires. The optional
[`@vantreeseba/graphql-casl-codegen`](../graphql-casl-codegen) plugin appends the
`AppSubjectMap`, `Subject` and `typed` bindings that
[step 1](#1-build-abilities) otherwise writes by hand, so the subject list tracks
the schema instead of being maintained alongside it.

Codegen is not a requirement — `SubjectMap` only needs types of that *shape*, so
a hand-written `Resolvers`/`ResolversTypes` pair works too. It is just far easier
to keep generated ones honest.

#### Starting without generated types

You do not need them to start. `AnyResolvers` is the loose stand-in, and it is
the **default**, so a map with no generic supplied simply works:

```ts
import { applyPermissions, type AnyResolvers, type PermissionsMap } from '@vantreeseba/graphql-casl';

const permissions: PermissionsMap<AnyResolvers> = {
  Query: { notes: canUser(Actions.read, Subject.Note) },
};

applyPermissions(schema, permissions);
```

Type and field names go unchecked at compile time — and are still checked at
**startup**, because `applyPermissions` walks the real schema and raises an
aggregated [`PermissionsError`](#4-apply-to-the-schema) naming every key that does not
exist. A stale key fails loudly; it just fails when the server boots rather than
when you build.

That is the intended starting point on a large generated CRUD schema
(Prisma/TypeGraphQL, Pothos CRUD, drizzle-graphql), where running
`typescript-resolvers` over the whole surface is a project of its own. Supply
your generated `Resolvers` when you have them and the same map starts being
checked at compile time. Codegen is an upgrade, not a precondition.

## Quick start

A todo API where callers may read any todo but update only their own. This is
the whole shape; each step is expanded under [Usage](#usage).
[`test/example.test.ts`](./test/example.test.ts) is this same example, under test.

```graphql
type Query {
  todos: [Todo!]!
  health: String!
}
type Mutation {
  # ownerId is an argument so the rule can check ownership before the resolver runs
  setDone(id: ID!, ownerId: ID!, done: Boolean!): Todo
  deleteAllTodos: Boolean
}
type Todo {
  id: ID!
  ownerId: ID!
  title: String!
  done: Boolean!
}
```

```ts
import { makeExecutableSchema } from '@graphql-tools/schema';
import {
  Actions,
  accept,
  applyPermissions,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  type PermissionsMap,
  type SubjectMap,
  subjectsOf,
} from '@vantreeseba/graphql-casl';
import type {
  MutationSetDoneArgs,
  Resolvers,
  ResolversTypes,
} from './__generated__/resolvers.js';

interface Context {
  userId?: string;
}

// Subjects are derived from your generated types — no domain names hand-listed.
type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;
const typed = createTyped<AppSubjectMap>();
const Subject = subjectsOf<AppSubjectMap>();

// 1. What each caller may do.
function abilitiesFor(userId: string | undefined) {
  const { can, build } = createGraphQLAbility<AppSubjectMap>();
  if (!userId) return build(); // no rules ⇒ anonymous callers can do nothing
  can(Actions.read, Subject.Todo);
  can(Actions.update, Subject.Todo, { ownerId: userId }); // only your own
  return build();
}

// 2. Bind abilities and the auth check to your context.
const canUser = createCan<Context, AppSubjectMap>(
  async (ctx) => abilitiesFor(ctx.userId),
  (ctx) => ctx.userId != null,
  typed, // tags subjects with __typename so conditions can be checked
);

// 3. Say which rule guards which field.
const permissions: PermissionsMap<Resolvers> = {
  Query: {
    todos: canUser(Actions.read, Subject.Todo),
    health: accept, // public
  },
  Mutation: {
    setDone: canUser(Actions.update, Subject.Todo, (args: MutationSetDoneArgs) => ({
      ownerId: args.ownerId,
    })),
    deleteAllTodos: deny, // nobody, ever
  },
};

// 4. Apply the map to the schema (`typeDefs` and `resolvers` are your own).
const schema = applyPermissions<Resolvers>(
  makeExecutableSchema({ typeDefs, resolvers }),
  permissions,
);
```

An anonymous caller gets `Not authenticated`; a signed-in one gets `Forbidden`
on someone else's todo, and `health` answers either way.

Two things to reach for next: `fallbackRule: deny` so fields the map doesn't
name ship guarded rather than open ([Apply to the schema](#4-apply-to-the-schema)),
and `canUser.onResult` so conditions are checked against the record the resolver
loaded rather than the arguments the client sent
([Post-execution rules](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/post-execution-rules.md)).

### What a caller sees

Those rules, as responses — every row is asserted in
[`test/example.test.ts`](./test/example.test.ts):

| Request | Caller | Result |
| --- | --- | --- |
| `{ health }` | anyone | `{ "health": "ok" }` — `accept` skips the auth check entirely |
| `{ todos { id } }` | anonymous | `Not authenticated` |
| `{ todos { id } }` | alice | both todos |
| `setDone(id: "t1", ownerId: "alice")` | alice | succeeds — the condition matches her ability |
| `setDone(id: "t2", ownerId: "bob")` | alice | `Forbidden`, **and the resolver never ran** |
| `deleteAllTodos` | anyone | `Forbidden` — `deny` never passes |

A denial is an ordinary GraphQL error, so it arrives alongside whatever else
resolved:

```json
{
  "data": { "setDone": null },
  "errors": [{ "message": "Forbidden", "path": ["setDone"] }]
}
```

One sharp edge is visible in row two. `todos` is `[Todo!]!`, so a denial there
has no `null` to land on and bubbles to the root — `data` comes back `null` and
an authorized `health` in the same query is destroyed with it. That is standard
GraphQL non-null propagation rather than anything this library does, and
[`onDeny: 'filter'`](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/error-control.md#filtering-denials) is the way out.

Both messages are replaceable: see [Error control](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/error-control.md) for
`GraphQLError`s with codes, and
[Denial reasons from CASL](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/error-control.md#denial-reasons-from-casl) for per-rule messages.

## Concepts

| Export | What it does |
|---|---|
| `createGraphQLAbility<SubjectMap>()` | Returns a CASL `AbilityBuilder` typed against your schema — `can`/`cannot` conditions are checked against each subject's fields — with `__typename` detection applied by `build()`. |
| `buildGraphQLAbility<SubjectMap>(rules, options?)` | Rebuilds an ability from stored `GraphQLRule`s (e.g. rules persisted in a database and loaded at startup). |
| `validateGraphQLRules(schema, rules, options?)` | Checks stored `GraphQLRule`s against the runtime schema — subjects, `fields`, condition fields and operators — and throws a `PermissionsError` listing every stale one, rather than letting it silently never grant. |
| `createCan(getAbility, isAuthenticated, buildSubject?)` | Factory that returns a `requireCan(action, subject, getSubjectData?)` rule builder, bound to your context shape and ability builder. `requireCan.onResult(...)` authorizes the resolved value instead of the args; `requireCan.fields(...)` guards every field of a type from the ability's field lists. |
| `createTyped<SubjectMap>()` | Returns a `typed(type, attrs)` helper that tags plain objects with `__typename` for subject detection. |
| `subjectsOf<SubjectMap>()` | Returns a `Subject` namespace of typo-proof subject names, read from the map. Optional — bare string literals are checked identically. |
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

### Subjects

Before CASL can pick the rules that apply to an object it has to know what the
object *is*, and a plain `{ id, ownerId }` does not say. That question is the
whole difficulty of binding CASL to a data source.
[`@casl/prisma`](https://github.com/stalniy/casl/tree/master/packages/casl-prisma)
has to wrap every record in CASL's `subject('Todo', record)` helper before a
check, because Prisma returns DTOs with no type information; its README notes
there is no easy fix short of adding a column to every model
([prisma/prisma#5315](https://github.com/prisma/prisma/issues/5315)). The name
passed to `subject()` is a string the record never carried, and nothing checks
it against anything.

GraphQL already has that answer. Every object type has a canonical name, the
spec reserves a field to carry it — `__typename` — and `GraphQLAbility` detects
subjects from exactly that field, which `build()` wires in. So the subject
vocabulary *is* the schema's type vocabulary: `createTyped()` tags a value with
a `__typename` narrowed to your `SubjectMap`, a misspelled tag is a compile
error, and a value that already carries `__typename` needs no wrapping at all.
That free, schema-checked type name is the structural reason a GraphQL-specific
CASL binding exists.

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
and rehydrate with `buildGraphQLAbility` (see [Persisting rules](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/stored-rules.md)).

## Usage

The four steps below are the quick start above, one piece at a time.
Everything past step 4 is optional depth — see [Guides](#guides).

### 1. Build abilities

Bind the generic helpers to your app's generated types and define abilities with
`createGraphQLAbility`. It returns a CASL `AbilityBuilder` typed against your
`SubjectMap`, so `can`/`cannot` conditions are checked against each subject's
fields, and `build()` wires `__typename` subject detection for you.

```ts
import {
  Actions,
  createGraphQLAbility,
  createTyped,
  type GraphQLAbility,
  type SubjectMap,
  subjectsOf,
} from '@vantreeseba/graphql-casl';
import type { Resolvers, ResolversTypes } from './__generated__/resolvers.js';

export type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;
export type AppAbility = GraphQLAbility<AppSubjectMap>;

export const typed = createTyped<AppSubjectMap>();
export const Subject = subjectsOf<AppSubjectMap>();

export function defineAbilitiesFor(userId: string | undefined): AppAbility {
  const { can, build } = createGraphQLAbility<AppSubjectMap>();
  if (!userId) return build(); // no rules ⇒ everything denied
  can(Actions.read, Subject.Note);
  can(Actions.update, Subject.Note, { userId }); // typed against Note's fields
  return build();
}
```

`Subject` is a convenience, not a requirement. Every API that takes a subject
name accepts the bare string literal and checks it just as strictly, so
`can(Actions.read, 'Note')` is equivalent to `can(Actions.read, Subject.Note)`
and a misspelled `'Note'` is a compile error either way. Use `subjectsOf` when
you want the autocomplete and a rename anchor; skip it otherwise. It takes no
argument — the names come from `AppSubjectMap`, so there is no list to keep in
step with the schema.

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
> — an IDOR. Use [`canUser.onResult`](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/post-execution-rules.md) to authorize the
> record the resolver actually loaded, make the resolver **scope by the same
> field the rule authorized** (look up by `id` **and** `userId`), derive the
> owner from `context` rather than args, or enforce ownership in your data layer.

The last of those is not one option among four. Ownership enforced in the data
layer — Postgres row-level security, a per-request client scoped to the caller,
a repository that takes the owner from the session and never from a parameter —
holds no matter which code path reaches the data: a resolver the map forgot, a
relation field a generated resolver routes through, a script, a second API. A
resolver gate holds only for the resolvers it wraps. That makes the data-layer
check **strictly stronger** than anything this library, or any resolver-level
library, can do, and graphql-casl is defense in depth on top of it rather than
a replacement for it: a rule denies before a query is issued, names the reason,
and keeps the policy in one typed map, while the data layer catches whatever
the map missed. Inside the library, [`canUser.onResult`](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/post-execution-rules.md)
is the mitigation — the condition is checked against the record that was loaded
rather than the argument that was sent — and
[`accessibleBy`](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/row-level-filtering.md) pushes the decision into the query
itself, so the rows a caller may not see are never fetched.

Better still is a schema in which a forged argument has nowhere to go. The
quick start's `setDone(id:, ownerId:)` takes the owner from the client, which is
why it needs both a rule and a scoped lookup. Root authorized reads at the
caller instead:

```graphql
type Query {
  viewer: Viewer!   # the caller, from context — takes no argument
}
type Viewer {
  todos: [Todo!]!   # only ever the caller's own
}
```

`viewer { todos }` cannot return another user's todos because no resolver on
that path accepts an owner; it reads `ctx.userId` and nothing else. Every
condition derived from arguments — every `getSubjectData(args)` — is an IDOR
waiting for a resolver that trusts it, which is exactly what
[the IDOR test](./test/example.test.ts) in the worked example pins down. The
viewer pattern removes that class of bug from the schema rather than guarding
against it, and it needs no library at all. Rules still earn their place on the
fields that must take an id — `note(id:)`, `updateNote(id:)` — where `onResult`
authorizes the record rather than the argument.

> ⚠️ **A bare subject name does not evaluate conditions.**
> `ability.can('update', 'Note')` asks CASL whether updating a Note is *possible
> at all*, not whether it is permitted on a particular one. Given
> `can('update', 'Note', { userId })`, the bare check returns `true` for every
> caller. Omitting `getSubjectData` there is not a type error, so `createCan`
> detects it at request time and warns once per rule; pass
> `{ onUnconditionedSubject: 'throw' }` to make it a denial, or `'allow'` when the
> possibility check is deliberate (a list field whose rows you filter inside the
> resolver).

### 4. Apply to the schema

```ts
import { applyPermissions } from '@vantreeseba/graphql-casl';

const schemaWithPermissions = applyPermissions<Resolvers>(schema, permissions);
```

`applyPermissions` keeps `permissions` typed as a `PermissionsMap<Resolvers>`, so
a mistyped type or field name is caught at compile time — or, if you have no
generated `Resolvers` yet, at startup instead; see
[Starting without generated types](#starting-without-generated-types). It also
re-checks the map against the runtime schema and throws a `PermissionsError`
listing **every** problem at once — which is what catches rules loaded from a database, written in
plain JavaScript, or built against a schema that has since drifted.

Entries that would be silently inert are rejected rather than ignored: a named
field on a union (which declares none) is an error, and introspection types
cannot be guarded. Fields resolve against the concrete object type, so a rule
keyed on an interface is inherited by every type implementing it rather than
left to never run — see [Rules on interfaces](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/interface-rules.md). In an
authorization library, a rule that quietly never runs is the worst failure mode,
so it is an error.

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

Read as modes, the way `@envelop/generic-auth` names its own, the choice is:

| Mode | Spelling | What it guarantees |
| --- | --- | --- |
| **Granular** | the default | only what the map names is guarded; a field it does not mention is open |
| **Protect all** | `fallbackRule: deny` | every field is guarded; the map is the allow-list, and a field added later ships closed |
| **Strict** | `strict: true`, on top of either | the error-side defaults of 2.0 — a denial filters instead of nulling the branch, and a resolver error is masked rather than passed through — see [The 2.0 defaults](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/error-control.md#the-20-defaults) |

Each mode is one option underneath, so they compose: `fallbackRule: deny` with
`strict: true` is deny-by-default with the stricter delivery, and either alone is
exactly what it says.

`fallbackRule` is one of several options. Four govern what a denial looks like to
the client — see [Error control](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/error-control.md) — and `strict` picks the 2.0
defaults for them. `disabled` is [the test switch](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/testing.md#switching-the-map-off).
The last, `inPlace`, is about apply time:

```ts
const schema = applyPermissions<Resolvers>(baseSchema, permissions, {
  fallbackRule: deny,
  inPlace: true, // guard `baseSchema` itself instead of building a copy
});
```

By default `applyPermissions` returns a guarded *copy* built by
`graphql-middleware`. That rebuild is where all the apply time goes — tens of
milliseconds per thousand types, seconds on a large generated CRUD schema —
while the rules themselves resolve in a fraction of that. `inPlace: true` skips
the copy and replaces the guarded fields' resolvers on the schema you passed,
with the same field selection and the same enforcement.

This is an **apply-time** saving only; per-request cost is identical in both
modes. For a long-lived server that builds its schema once, the difference is a
one-off few tens of milliseconds and the default is the right choice. Reach for
`inPlace` where `applyPermissions` runs over and over: a test suite that guards a
fresh schema per test, hot reload in development, per-tenant schemas, or a
gateway that recomposes. The schema is mutated and also returned; apply it once
per schema, since guarding an already-guarded schema throws rather than stacking
two maps. If something else already holds the schema and expects it unguarded,
leave `inPlace` off, or use the
[envelop plugin](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/envelop.md), which never rebuilds.

## Guides

Everything past the four steps, in rough order of how often it comes up. Each
guide is its own page.

| Guide | Use it when |
| --- | --- |
| [Post-execution rules](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/post-execution-rules.md) | The condition belongs to the record the resolver loads, not to the client's arguments |
| [Field-level rules](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/field-level-rules.md) | A single field of a type needs its own rule |
| [Field permissions from the ability](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/field-permissions-from-the-ability.md) | The ability already lists fields (`can('read', 'User', ['id'])`) and you don't want to restate them |
| [Combining rules](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/combining-rules.md) | A field needs more than one check — `and` / `or` / `not` / `chain` / `race` / `wrap` |
| [Caching a rule's answer](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/caching.md) | An async rule runs once per field per object and should run once per request, or once per row |
| [Granting a parent's decision to its fields](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/granted-scopes.md) | A list already authorized its rows and the type rule re-checks them once per field |
| [Error control](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/error-control.md) | `Forbidden` isn't enough: you need codes, filtering, or a look at what actually broke |
| [Wildcards](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/wildcards.md) | One rule should cover a whole type, or one field across every type |
| [Rules on interfaces](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/interface-rules.md) | One rule should cover every type implementing an interface, new ones included |
| [Row-level filtering](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/row-level-filtering.md) | A list should return fewer rows rather than be denied outright |
| [Scoping generated resolvers](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/scoping.md) | The resolver is generated and you can only reach its arguments |
| [Validating arguments](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/validating-arguments.md) | The arguments need checking the SDL cannot express — blank strings, ranges, one field against another |
| [Using the map without `graphql-middleware`](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/custom-integration.md) | You're building your own integration |
| [Enforcing the map through envelop](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/envelop.md) | Yoga, Apollo 4+, a gateway, or any schema you don't own |
| [Delegating to an external policy engine](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/external-policy-engine.md) | Permissions are relationship-derived — OpenFGA, Cerbos, OPA, Oso |
| [Persisting rules](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/stored-rules.md) | Rules live in a database rather than in code |
| [Testing your permissions](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/testing.md) | You want the rules covered, including the argument-forging case |

The opposite need — the schema *without* its rules, to seed a fixture through
the same resolvers or to prove a failure is the resolver's and not
authorization's — is `disabled: true`:

```ts
const open = applyPermissions<Resolvers>(baseSchema, permissions, { disabled: true });
```

The map is still validated, so a stale rule still throws; the schema comes back
as it went in — the same object, with or without `inPlace` — and the envelop
plugin does the same, validating and wrapping nothing. It is a test-only switch.
Do not wire it to an environment variable you do not control, or a
misconfigured deploy ships with every rule off and nothing to say so.

## Coming from `graphql-shield`

The map you already have mostly transfers; what changes is the rule *body*. The
concept-mapping table, the three differences that will bite, and what the port
is for are in [Coming from `graphql-shield`](https://github.com/cubicecho/graphql-casl/blob/main/packages/graphql-casl/docs/guides/shield-migration.md).
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
