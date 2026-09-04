# @vantreeseba/graphql-casl

A [`graphql-middleware`](https://github.com/maticzav/graphql-middleware) plugin for
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
([Post-execution rules](#post-execution-rules)).

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
[`onDeny: 'filter'`](#filtering-denials) is the way out.

Both messages are replaceable: see [Error control](#error-control) for
`GraphQLError`s with codes, and
[Denial reasons from CASL](#denial-reasons-from-casl) for per-rule messages.

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
and rehydrate with `buildGraphQLAbility` (see [Persisting rules](#persisting-rules-optional)).

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
> — an IDOR. Use [`canUser.onResult`](#post-execution-rules) to authorize the
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
the map missed. Inside the library, [`canUser.onResult`](#post-execution-rules)
is the mitigation — the condition is checked against the record that was loaded
rather than the argument that was sent — and
[`accessibleBy`](#row-level-filtering) pushes the decision into the query
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
left to never run — see [Rules on interfaces](#rules-on-interfaces). In an
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

`fallbackRule` is one of six options. Four govern what a denial looks like to
the client — see [Error control](#error-control). The last, `inPlace`, is about
apply time:

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
[envelop plugin](#enforcing-the-map-through-envelop-optional), which never rebuilds.

## Guides

Everything past the four steps, in rough order of how often it comes up.

| Guide | Use it when |
| --- | --- |
| [Post-execution rules](#post-execution-rules) | The condition belongs to the record the resolver loads, not to the client's arguments |
| [Field-level rules](#field-level-rules) | A single field of a type needs its own rule |
| [Field permissions from the ability](#field-permissions-from-the-ability) | The ability already lists fields (`can('read', 'User', ['id'])`) and you don't want to restate them |
| [Combining rules](#combining-rules) | A field needs more than one check — `and` / `or` / `not` / `chain` / `race` / `wrap` |
| [Granting a parent's decision to its fields](#granting-a-parents-decision-to-its-fields) | A list already authorized its rows and the type rule re-checks them once per field |
| [Error control](#error-control) | `Forbidden` isn't enough: you need codes, filtering, or a look at what actually broke |
| [Wildcards](#wildcards) | One rule should cover a whole type, or one field across every type |
| [Rules on interfaces](#rules-on-interfaces) | One rule should cover every type implementing an interface, new ones included |
| [Row-level filtering](#row-level-filtering) | A list should return fewer rows rather than be denied outright |
| [Scoping generated resolvers](#scoping-generated-resolvers-optional) | The resolver is generated and you can only reach its arguments |
| [Validating arguments](#validating-arguments) | The arguments need checking the SDL cannot express — blank strings, ranges, one field against another |
| [Using the map without `graphql-middleware`](#using-the-map-without-graphql-middleware) | You're building your own integration |
| [Enforcing the map through envelop](#enforcing-the-map-through-envelop-optional) | Yoga, Apollo 4+, a gateway, or any schema you don't own |
| [Delegating to an external policy engine](#delegating-to-an-external-policy-engine) | Permissions are relationship-derived — OpenFGA, Cerbos, OPA, Oso |
| [Persisting rules](#persisting-rules-optional) | Rules live in a database rather than in code |
| [Testing your permissions](#testing-your-permissions) | You want the rules covered, including the argument-forging case |

### Post-execution rules

`canUser.onResult` runs the resolver first and checks the ability against **what
it returned**, so conditions are evaluated on the real record rather than on what
the client asserted. This is the direct fix for the IDOR shape warned about in
[step 3](#3-declare-the-permissions-map).

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

An error raised *inside* a check propagates out of the rule unchanged rather
than becoming a denial, so the two stay distinguishable. What `applyPermissions`
then does with it is a separate decision: by default a rule failure *is* reported
to the client as a denial, so it does not leak internals, and `debug: true`
rethrows it untouched. See [Error control](#error-control) — the table there is
the end-to-end behaviour, this paragraph is only about the rule layer.

A check's `context` is typed `any`, so a value outside that contract can still
reach the rule — `ctx.auth?.root` type-checks and is `undefined` when `auth` is
absent. Any such value is read for its truthiness, so `undefined` and `null`
deny with `Forbidden` rather than crashing the request. Return a `boolean` to
stay on contract; the coercion is a safety net, not a second supported form.

#### Caching a rule's answer

A rule attached to a *type* guards every field of it, so it runs **once per field
per object**: a 100-row list with 5 selected fields evaluates it 500 times. That
is free for a synchronous role check and expensive for the async rules this
library encourages — a [policy engine](#delegating-to-an-external-policy-engine)
round trip, a row load. `cache` bounds it:

```ts
rule(check, { name: 'isOrgMember', cache: 'contextual' }) // once per request
rule(check, { name: 'canEdit',     cache: 'strict' })     // once per (parent, args)
```

| `cache` | Evaluations for 100 rows x 5 fields | Use when |
| --- | --- | --- |
| `'no_cache'` (default) | 501 | the answer can change between fields, or reads something mutable |
| `'strict'` | 101 | the answer depends on the row being authorized |
| `'contextual'` | 1 | the answer depends only on the context — `isAuthenticated`, `hasRole` |

The cache is per rule and per request: entries hang off the context object in a
`WeakMap`, so they are unreachable once the request is, and nothing is shared
between requests. An async check's *pending promise* is stored rather than the
resolved value, so concurrent field resolutions on one list share a single
in-flight call instead of stampeding. A rejection is cached alongside it, so a
broken check fails the request once rather than 500 times. A synchronous check
is stored as its plain answer, and a rule whose check answers synchronously
never allocates a promise of its own.

`'strict'` keys on the parent's *identity* and the arguments' *content* (keys
are sorted, so `{ a, b }` and `{ b, a }` match). It does not key on the field
name: a rule whose answer differs per field of the same parent — `createCan.fields`
is one — needs `'no_cache'` or a key function. Arguments that cannot be
serialised (a `BigInt`, a cycle) make that call run uncached rather than throw.

When neither level fits, pass a function and key on whatever you like.
Returning `undefined` skips the cache for that call:

```ts
// One answer per org per request, whichever rows or fields ask.
rule(check, { name: 'isOrgMember', cache: (parent) => parent?.orgId });
// One answer per (parent, field).
rule(check, { cache: (parent, _args, _ctx, info) => `${parent.id}:${info.fieldName}` });
```

Rules built by `createCan` take the same option as a fourth argument. The bare
form is already answered once per ability, so it matters for the conditioned
form, where `'strict'` matches the CASL conditions once per row rather than
once per selected field of it:

```ts
canUser(Actions.update, 'Note', (_args, parent) => ({ userId: parent.userId }), {
  cache: 'strict',
});
```

`'no_cache'` stays the default because it is the safe one — caching a check that
reads something mutable is a correctness bug, and only you know whether yours
does. A context that is not an object cannot key a `WeakMap`, so such a rule is
simply never cached.

When the rows were already authorized by the field that returned them, a
[granted scope](#granting-a-parents-decision-to-its-fields) skips the per-row
check altogether rather than caching it.

Rules built by `rule()` or `createCan(...)`, plus `accept` and `deny`, are
**combinable**: their verdict can be asked for without running the resolver, so
they work as operands of the combinators.

| Combinator | Passes when | Evaluation | Error on failure | An operand that *throws* |
| --- | --- | --- | --- | --- |
| `and(...rules)` | every operand passes | parallel, all evaluated | the **first** failing operand's | fails the rule |
| `chain(...rules)` | every operand passes | sequential, stops at first failure | the failing operand's | fails the rule |
| `or(...rules)` | any operand passes | parallel, all evaluated | the **last** operand's | counts as a failed operand |
| `race(...rules)` | any operand passes | sequential, stops at first pass | the **last** operand's | counts as a failed operand |
| `not(rule, error?)` | the operand fails | — | `error`, else `Forbidden` | fails the rule |

In `or` and `race` a **broken** operand loses rather than poisoning the field, so
a passing branch still carries it. That matters for the shape a ported
`graphql-shield` map is full of — a cheap guard plus a check that depends on it:

```ts
Query: { thing: or(isRoot, hasRole('ADMIN')) }
```

For a machine identity with no `ctx.user`, `hasRole`'s inner check *throws*
rather than denying. `isRoot` still carries the field. If no operand passes and
one of them threw, that error is rethrown in preference to any denial — a rule
that broke is an outage to report, not an access decision. `and`, `chain` and
`not` stay strict; `not` especially, where a broken operand must never flip to
allow.

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

### Granting a parent's decision to its fields

A list field that authorized its rows is followed, on every row, by a type rule
that authorizes them again — once per selected field.
[Caching](#caching-a-rules-answer) bounds that to once per row. A **granted
scope** removes it: the field that returns the objects *grants* them a named
scope, and the rule on their type accepts the grant instead of asking CASL.

```ts
import { granted, grants, race } from '@vantreeseba/graphql-casl';

export const permissions: PermissionsMap<Resolvers> = {
  Query: {
    // authorizes the list once, then grants every returned Post the 'post' scope
    posts: grants(canUser(Actions.read, Subject.Post), 'post'),
  },
  // a granted row passes on a WeakMap lookup; anything else falls through to CASL
  Post: race(granted('post'), canUser.fields(Actions.read, Subject.Post)),
};
```

`grants(rule, scope)` wraps any rule and leaves its verdict alone. Once the rule
has let the resolver run and the resolver has answered, whatever it returned —
the object, or each object of a list, nested lists included — is tagged with
`scope` for the rest of the request. `scope` may also be a list of names.
`granted(scope)` is a combinable rule that passes when its `parent` carries the
scope and denies with `Forbidden` otherwise. Put it **first in a `race`**: `race`
stops at the first operand that passes, so the CASL check behind it runs only
for rows that arrived some other way. `or` evaluates every operand, so it would
still pay for the check it was meant to skip.

This is Pothos' `grantScopes` / `$granted`, and it keeps the same rules:

- **A grant is not transitive.** `Post.author` returns a `User`, and that `User`
  is not granted `'post'`. Its fields need their own rule — or `Post.author`
  grants in turn: `author: grants(granted('post'), 'user')`.
- **Only what the field actually returns is granted.** A denial grants nothing,
  a resolver that throws grants nothing, and `grants(canUser.onResult(...),
  'post')` grants only the rows the post-execution check let through. `null`
  and scalars are ignored — they cannot be a `parent`.
- **Grants are per request.** They hang off the context object in a `WeakMap`,
  like the rule cache, so they die with the request and a second request sees
  none of them. A context that is not an object cannot carry them: such a
  request grants nothing and every `granted` rule in it denies, deny being the
  safe direction.
- **`granted` on its own is deny-by-default.** A `Post` reached through a field
  that does not grant — or a root field's `parent`, which is no object at all —
  is denied. That is what makes it a *scope* rather than a bypass; the `race`
  above is the shape for a type that is also reachable by paths that should
  authorize it themselves.
- **It needs no `cache`.** The check is a `WeakMap` lookup that answers
  synchronously, so a granted field resolves without a promise. Under `onDeny`
  an ungranted field is filtered or masked like any other denial, and
  `fallbackError` rewords it like any other generic one.
- **`grants(...)` is not combinable.** It decides by running the resolver, so
  like `onResult` and `scopeArgs` it is rejected as an operand of `and` / `or`
  / `not` / `chain` / `race` when the map is built. Compose it with `wrap`, or
  combine the rule *inside* it: `grants(chain(isNotBanned, canUser(...)), 'post')`.

What it saves is evaluations. For the 100-row, 5-field list the
[caching table](#caching-a-rules-answer) measures:

| Rule on `Post` | CASL checks per request |
| --- | --- |
| `canUser.fields(Actions.read, Subject.Post)` | 500, one per field per row |
| conditioned `canUser(...)` with `cache: 'strict'` | 100, one per row |
| `race(granted('post'), canUser.fields(...))` | 1, on the list field |

Wall-clock, the difference is smaller than the counts suggest: a synchronous
CASL check already sits close to the unguarded graphql-js baseline, so the
grant mostly removes work that was cheap. Where it is not cheap — a
[policy engine](#delegating-to-an-external-policy-engine) round trip, a
conditioned check on a wide row, a `fields` rule whose ability has many rules —
the 500-to-1 is the whole point. `npm run bench` in the package prints the
current numbers side by side.

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

A fourth option, `onDeny`, changes how a denial is delivered rather than what it
says — see [Filtering denials](#filtering-denials) below.

> **Note for `graphql-shield` users:** `allowExternalErrors` defaults to `true`
> here, the opposite of shield, which masks resolver errors by default. Masking
> is the safer behaviour, but it is not what this library has done since 1.0 and
> silently swallowing resolver errors on upgrade would be worse than leaving the
> choice explicit. Set it to `false` deliberately.

#### Filtering denials

A thrown denial propagates up the non-null chain. Deny one field of
`todos: [Todo!]!` and the *whole* `data` payload becomes `null` — an
unauthorized corner of a query destroys the authorized rest of it. `onDeny`
chooses what a denied field does instead:

```ts
const schema = applyPermissions<Resolvers>(baseSchema, permissions, {
  onDeny: 'filter', // 'reject' (the default) | 'filter' | 'mask'
});
```

| `onDeny` | Denied field | The caller is told |
| --- | --- | --- |
| `'reject'` | throws, and non-null propagation applies | an `errors` entry, `Forbidden` |
| `'filter'` | resolves to `null` / `[]`; the rest of the query survives | an `errors` entry with the standard code and the field's path |
| `'mask'` | resolves to `null` / `[]`; the rest of the query survives | nothing |

**`'filter'`** is Apollo Router's partial-response contract. The response
carries the data the caller may see and one error per filtered field, with
`extensions.code: "UNAUTHORIZED_FIELD_OR_TYPE"` and the path, so clients and
tooling that already handle the router's authorization directives handle this
without learning anything new:

```json
{
  "data": { "todos": [], "health": "ok" },
  "errors": [
    {
      "message": "Forbidden",
      "path": ["todos"],
      "extensions": { "code": "UNAUTHORIZED_FIELD_OR_TYPE" }
    }
  ]
}
```

Filtering changes how a denial is delivered, not what it says. A CASL reason or
a check's own message is still the message, `fallbackError` still rewords a
generic denial, and a denial that names its own `extensions.code` keeps it.

**`'mask'`** says nothing at all, so "you may not read this" and "this does not
exist" become indistinguishable. That is the point when the existence of a
record is itself privileged, and a support burden otherwise. `maskDenials: true`
is the older spelling of the same mode.

Both are bounded by the schema:

| Field | Denied result |
| --- | --- |
| `me: User` | `null` |
| `todos: [Todo!]` | `null` |
| `todos: [Todo!]!` | `[]` |
| `id: ID!` | still throws — no value satisfies it, so it propagates to the nearest nullable ancestor (with the standard code under `'filter'`) |

And both touch only *denials*. A rule that threw a bug of its own, and a resolver
that failed on a permitted field, both still surface their errors — silently
nulling those would hide an outage as a permission decision.

##### Where filtered denials are reported

A nullable field carries its own report: it resolves to `null` and the error
sits at its path, which is how GraphQL delivers any field error. A non-null
list is different — `[]` cannot also be an error — so that denial is held per
request until `reportDenials` merges it into the finished result. Under
[envelop](#enforcing-the-map-through-envelop-optional) that happens for you.
`applyPermissions` never sees the finished response, so call it from your
server's own response hook, or straight after `execute`:

```ts
import { reportDenials } from '@vantreeseba/graphql-casl';

const result = reportDenials(contextValue, await execute({ schema, document, contextValue }));
```

Skip that call and those denials are silently masked — the one way `'filter'`
degrades. The record is keyed on the context value, so it must be an object,
one per request.

`report: 'extensions'` moves every filtered denial out of `errors` and into
`extensions.authorizationErrors` (the router's key again). That keeps `errors`
clean for clients that treat any entry there as a failed request — Apollo
Client's default `errorPolicy` among them — while still saying which parts of
the query were filtered. In this mode every denial goes through `reportDenials`.

```json
{
  "data": { "me": null },
  "extensions": {
    "authorizationErrors": [
      {
        "message": "Forbidden",
        "path": ["me"],
        "extensions": { "code": "UNAUTHORIZED_FIELD_OR_TYPE" }
      }
    ]
  }
}
```

The default stays `'reject'`, so nothing changes on upgrade. `'filter'` is the
better choice for new code and is the planned default for 2.0.

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

From highest precedence to lowest, for a `Note` that implements `Node`:

| Entry | Matches |
| --- | --- |
| `{ Note: { body: rule } }` | a named field of a named type |
| `{ Node: { body: rule } }` | a named field of an interface the type implements |
| `{ Note: { '*': rule } }` or `{ Note: rule }` | any field of a named type |
| `{ Node: { '*': rule } }` or `{ Node: rule }` | any field of any type implementing the interface (a union's `'*'` sits here too) |
| `{ '*': { body: rule } }` | a named field of any type |
| `{ '*': { '*': rule } }` or `{ '*': rule }` | any field of any type |
| `fallbackRule` | everything else |

Field names under `'*'` are still checked — against every field in the schema, so a
typo that matches no type at all is an error.

### Rules on interfaces

An interface is a type key like any other. A rule under it guards that field on
every type implementing the interface — including one added to the schema after
the map was written, which is the point: a rule restated on each implementor
silently misses the next one.

```ts
const permissions: PermissionsMap<Resolvers> = {
  Node: { id: accept },                          // Note.id, User.id, and whatever implements Node next
  Searchable: canUser(Actions.read, Subject.Note), // every field of every Searchable
  Note: { body: canUser(Actions.read, Subject.Note) },
};
```

The field keys are the fields the interface declares — `Node: { body: rule }` is
an error, since `Node` has no `body` — but a type-wide `'*'` (or a bare rule)
on an interface covers every field of the implementor, declared on the interface
or not. Implementation is transitive: an interface that implements `Node` passes
`Node`'s rules on to its own implementors. A union takes only `'*'`, which guards
every field of every member; a named field on a union is an error, because a
union declares none. Either kind of entry guards the type wherever it is
reached: `Thing: rule` guards `Note`'s fields under `Query.note` as much as
under `Query.thing`.

An implementor's own entry beats the interface's, at the same tier — the table
above states the order. What the map never does is pick one of two inherited
rules for you: a `Note` implementing both `Node` and `Searchable`, where both
give a rule for `id` (or both give `'*'`) and `Note` does not, is ambiguous, and
`applyPermissions` rejects it with a `PermissionsError` naming both interfaces
until `Note` chooses. The same rule reached through two interfaces is fine.

With `typescript-resolvers`, the interface's resolver type lists its fields
alongside `__resolveType`, so `PermissionsMap<Resolvers>` checks the field keys
under `Node` at compile time exactly as it does under `Note` — and a union's
resolver type, which has only `__resolveType`, accepts only `'*'`. Under
`onlyResolveTypeForInterfaces: true` an interface accepts only `'*'` too; the
runtime walk still checks every key either way.

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
// `drizzleFilters` is a copyable recipe, not an export — see
// test/recipes/drizzleGraphql.ts, and the note under Row-level filtering.
import { drizzleFilters } from './drizzleFilters.js';

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

Five things to know before reaching for it:

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
- **It scopes the field you name, not the graph below it.** `scopeArgs` rewrites
  one field's arguments, so it reaches exactly the rows *that* field resolves.
  A generated *relation* field — `Note.author`, `User.notes` — resolves through
  its own path and may ignore an injected filter entirely, handing back rows the
  scope would have excluded while reporting success. drizzle-graphql does this
  under its default config. Scope each relation field in its own right, put a
  rule on it, or push the scope into the data layer — Postgres row-level
  security, a per-request scoped client — where nothing can route around it.
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

### Validating arguments

GraphQL's input coercion checks *shape* — the right scalars in the right
places. It has nothing to say about a title that is blank, an end date before
its start, or a page size of ten million, so those checks end up hand-written at
the top of each resolver. `validateArgs` lifts them into the permissions map,
next to the authorization the same field needs.

It takes any [Standard Schema](https://standardschema.dev) — a zod (3.24+),
valibot, arktype or yup (1.7+) schema, or anything else with a `~standard`
property — so you bring the validator you already use and the package adds no
dependency:

```ts
import { validateArgs, wrap } from '@vantreeseba/graphql-casl';
import { z } from 'zod';

const CreateNoteArgs = z.object({
  input: z.object({
    title: z.string().trim().min(1, 'A note needs a title'),
    tags: z.array(z.string()).max(10).default([]),
  }),
});

const permissions = {
  Mutation: {
    createNote: wrap(canUser(Actions.create, Subject.Note), validateArgs(CreateNoteArgs)),
  },
} satisfies PermissionsMap<Resolvers>;
```

On success the resolver receives the schema's **parsed output** as its `args` —
`title` trimmed, `tags` defaulted — which is the point of running a schema
rather than a predicate. `ValidatedArgs<typeof CreateNoteArgs>` names that type.
Pass `{ replace: false }` to validate only and leave the arguments exactly as
GraphQL coerced them.

On failure the field rejects with a `GraphQLError` whose message lists the
issues, with `extensions.code: 'BAD_USER_INPUT'` and an `extensions.issues`
array of `{ message, path }`:

```json
{
  "message": "input.title: A note needs a title",
  "path": ["createNote"],
  "extensions": {
    "code": "BAD_USER_INPUT",
    "issues": [{ "message": "A note needs a title", "path": ["input", "title"] }]
  }
}
```

That failure is **not a permission denial**, and [error control](#error-control)
treats it accordingly: `fallbackError` never rewords it, since it named its own
error; `debug` has nothing to reveal; and under `onDeny: 'filter'` it keeps
`BAD_USER_INPUT` rather than taking `UNAUTHORIZED_FIELD_OR_TYPE`. The one mode
that treats it like a denial is `onDeny: 'mask'`, which nulls the field and says
nothing — bad input then reads as a missing record, the trade-off `'mask'`
already makes everywhere. An error thrown by the validator *itself* is a rule
failure, not a validation result, and is replaced or revealed as one.

Three things to know:

- **It is not a gate**, and like `scopeArgs` it cannot be an operand of `and` /
  `or` / `not` / `chain` / `race` — it decides by rewriting arguments and calling
  the resolver. Compose it with `wrap`, and put the authorization rule *first*:
  a caller who may not run the field at all should learn that, not what is wrong
  with their input.
- **Rewritten arguments bypass GraphQL's coercion**, exactly as `scopeArgs`'s do.
  A transform that changes a value's *type* — a string into a `Date` — hands the
  resolver something the SDL never promised. Often that is the point; make sure
  the resolver expects it.
- **Coming from `graphql-shield`'s `inputRule`**: same idea, no yup dependency,
  and the parsed output reaches the resolver instead of being thrown away.

### Using the map without `graphql-middleware`

`applyPermissions` is `resolvePermissions` plus `graphql-middleware`.
`resolvePermissions` stops one step earlier and hands back the per-field lookup,
so the same map can be enforced through another integration — the envelop entry
point below, an Apollo plugin, hand-wrapped resolvers — with identical wildcard
precedence, `fallbackRule` coverage, error control and filtering:

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
      onDeny: 'filter',
    }),
  ],
});
```

`options.permissions` is the map; every other key is an
[`ApplyPermissionsOptions`](#error-control) field. Wildcard precedence,
`fallbackRule` coverage, error control and filtering all behave exactly as they
do under `applyPermissions` — the plugin calls `resolvePermissions` rather than
reimplementing any of it. Beyond that:

- **Filtered denials are reported for you.** Under `onDeny: 'filter'` the plugin
  merges each request's held denials into the result as execution finishes, so
  there is no `reportDenials` call to wire.

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
verdict in your logs and hides the outage. `onDeny` respects the same line and
will neither filter nor mask it.

**Cache the decision per request.** One query can touch the same object dozens
of times, and each one is a round trip. Set [`cache`](#caching-a-rules-answer)
rather than memoizing by hand:

```ts
const canRead = rule(
  (_parent, _args, ctx: Context) => askOpenFga(ctx.user, 'read'),
  { name: 'canRead', cache: 'contextual' },
);
```

That stores the *pending promise*, so concurrent sibling fields share one call
rather than starting several.

For list fields, a PDP with a "list objects the user can access" endpoint plays
the role [`accessibleBy`](#row-level-filtering) plays for CASL rules: fetch the
allowed ids first and filter the query, rather than resolving rows and denying
them one by one.

[openfga]: https://openfga.dev
[cerbos]: https://cerbos.dev
[opa]: https://www.openpolicyagent.org
[oso]: https://www.osohq.com

### Persisting rules (optional)

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

Rules in a database are edited outside the type system, and
`buildGraphQLAbility` accepts whatever it is given. A stale row does not error —
it silently never grants: a condition on a field that has since been renamed
matches no record, a subject that no longer exists is never asked about, and an
operator CASL does not know throws on the first `can()` that reaches it,
mid-request. `validateGraphQLRules` checks the rows against the runtime schema
and throws a `PermissionsError` naming every problem, so call it where the rules
are loaded — and in a test:

```ts
import { validateGraphQLRules } from '@vantreeseba/graphql-casl';

const rules = await db.loadPermissionRules();
validateGraphQLRules(schema, rules); // PermissionsError: Rule 3 (`update` on `Note`): condition field `ownr` is not a field of `Note`.
const ability = buildGraphQLAbility<AppSubjectMap>(rules);
```

Per rule it checks the shape (a string or string-array `action` and `subject`; a
boolean `inverted`, since CASL reads any truthy value — the string `"false"`
included — as a denial), that `action` is one of `Actions`, that `subject` is
`all` or an object type in the schema (not a root operation type, and not an
interface or union, which `__typename` detection can never match), that each of
`fields` is a field of the subject, and that `conditions` uses only operators
CASL's matcher supports and names only fields of the subject, following dotted
paths through object-typed fields. Condition *values* are not checked.

That last check assumes conditions name GraphQL fields. If your subjects are
database models — codegen `mappers` pointing `ResolversTypes` at your ORM types
— a rule may legitimately condition on a column the schema does not expose.
Pass `{ conditionFields: 'none' }` to check only the shape and operators of
conditions; subjects and `fields` are still checked, since those are schema
names either way.

### Testing your permissions

A guarded schema is just a schema, so rules are testable with `graphql()` and a
plain object for the context — no server, no transport, no mocking of this
library:

```ts
import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import { expect, it } from 'vitest';

const schema = applyPermissions<Resolvers>(
  makeExecutableSchema({ typeDefs, resolvers }),
  permissions,
);

const run = (source: string, ctx: Context) => graphql({ schema, source, contextValue: ctx });

it('refuses to complete someone else’s todo', async () => {
  const result = await run(
    'mutation { setDone(id: "t2", ownerId: "bob", done: true) { id } }',
    { userId: 'alice' },
  );

  expect(result.errors?.[0]?.message).toBe('Forbidden');
});
```

Three assertions are worth making that a passing/failing check alone does not
cover:

- **That the resolver never ran.** A rule that denies *after* the side effect
  has already happened still reports `Forbidden`, so asserting the error is not
  enough — assert the data is unchanged too.
- **The forged-argument case.** Pass your own owner id alongside another user's
  record id. The gate passes, so what you are testing is that the resolver
  scoped its lookup by the field the rule authorized. This is the
  [IDOR shape](#3-declare-the-permissions-map), and it is the test most worth
  having.
- **The anonymous case for every public field.** `accept` and a missing map
  entry behave identically until you add `fallbackRule: deny`, at which point
  only the explicit `accept` still answers.

Because `applyPermissions` validates the map against the schema as it wraps it,
building the schema in a test is itself a check: a rule naming a field that no
longer exists throws a `PermissionsError` before any query runs. A single test
that only constructs the guarded schema will catch a whole class of drift.

If that is *all* a test wants, call `validatePermissions` instead. It runs the
same validation and throws the same aggregated `PermissionsError`, but builds no
middleware. If rules live in a database, `validateGraphQLRules` is the same
test for them (see [Persisting rules](#persisting-rules-optional)):

```ts
import { validateGraphQLRules, validatePermissions } from '@vantreeseba/graphql-casl';

it('names only fields that still exist', () => {
  expect(() => validatePermissions<Resolvers>(schema, permissions)).not.toThrow();
});

it('stored rules still match the schema', async () => {
  expect(() => validateGraphQLRules(schema, await db.loadPermissionRules())).not.toThrow();
});
```

The difference is cost. `applyPermissions` wraps a resolver for every guarded
field, so it is O(fields) — and with `fallbackRule` set, that is every field in
the schema. On a generated CRUD schema of 4,400 types and 35,200 fields,
`applyPermissions` takes ~1.6s where `validatePermissions` takes ~8ms. That cost
is paid once at startup, which is the right place for it; it is the wrong thing
to pay in every test file that only wants the drift check.

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
| a rule returning a non-boolean — shield coerces truthiness | same: a value outside the return contract is read for its truthiness, so a check yielding `undefined` denies |
| `and` / `or` / `not` / `chain` / `race` | same names, same semantics: `and`/`or` evaluate in parallel, `chain`/`race` short-circuit, `not(rule, error?)` |
| a rule that *throws* inside `or` / `race` | same: it counts as a failed operand, so another branch can still pass — see [the throw column](#combining-rules) |
| — | `wrap(...rules)` has no shield equivalent: it nests rules as middleware, so rules that decide by running the resolver can still be composed |
| `allow` / `deny` | `accept` / `deny` |
| `fallbackRule: deny` | same option |
| `'*'` field key | `'*'` in **either** position, with [documented precedence](#wildcards) |
| `shield(someRule)` — one rule for the whole schema | `fallbackRule`, or `{ '*': someRule }` |
| `fallbackError` | same option — but it replaces only denials that did not name their own error |
| `allowExternalErrors` | same option, **opposite default** — see below |
| `debug` | same option |
| `ValidationError` for a rule on a field the schema lacks | `PermissionsError`, aggregating *every* problem in the map rather than the first |
| `cache: 'contextual' \| 'strict'` per rule | [same option, same three levels](#caching-a-rules-answer), same default (`'no_cache'`) — and `createCan` memoizes `getAbility(context)` per request on top |
| `cache: (parent, args, ctx, info) => key` | same escape hatch; returning `undefined` skips the cache for that call. No `hashFunction`: `'strict'` keys arguments with a built-in sorted-key stringifier rather than `object-hash` |
| unique rule names required (the cache is keyed by name) | not required — each rule instance owns its cache, so two rules named `isOwner` never share an answer |
| `inputRule` (yup-backed argument validation) | [`validateArgs(schema)`](#validating-arguments), taking any Standard Schema (zod, valibot, arktype, yup 1.7+) — no validator dependency, and the parsed output reaches the resolver |
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
