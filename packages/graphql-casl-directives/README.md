# @vantreeseba/graphql-casl-directives

`@can` and `@rule` directives for
[`@vantreeseba/graphql-casl`](../graphql-casl): declare permissions next to the
fields they guard, in SDL, instead of in a parallel `PermissionsMap`.

This package is a translator, not an enforcer. `permissionsFromDirectives`
reads the directives off a `GraphQLSchema` and returns the same `PermissionsMap`
you would otherwise hand-write; `applyPermissions` or `useGraphQLCasl` then
enforce it exactly as before. Wildcards, `fallbackRule`, error control and
masking keep their one implementation — the directives only decide *which* rule
guards *which* field.

## Install

```bash
npm install @vantreeseba/graphql-casl-directives
# the runtime that enforces the map, and graphql
npm install @vantreeseba/graphql-casl graphql
```

Peer dependencies: `graphql >=16` and `@vantreeseba/graphql-casl >=1.5.0`.

## The two directives

Add `directiveTypeDefs` to your `typeDefs` — a directive has to be defined
before it can be used — and write them on fields, object types or interfaces.

```graphql
directive @can(action: String!, subject: String) repeatable on FIELD_DEFINITION | OBJECT | INTERFACE
directive @rule(names: [[String!]!]!) repeatable on FIELD_DEFINITION | OBJECT | INTERFACE
```

### `@can(action:, subject:)`

Becomes `can(action, subject)` on the `createCan` builder you pass in — a bare
CASL possibility check, like writing `canUser('read', 'Note')` in the map.
`action` is one of the runtime's actions: `create`, `read`, `update`, `delete`,
`manage`.

`subject` defaults to the type the directive is written on. On a root field
(`Query`, `Mutation`, `Subscription`) it defaults to the field's return type —
`notes: [Note!]! @can(action: "read")` checks `Note`. A root field that returns
a scalar or an enum has nothing to infer, so name the subject:
`@can(action: "read", subject: "Report")`.

### `@rule(names:)`

Becomes rules looked up in the registry you pass in. `names` is a list of
lists: the inner lists combine with `and`, the outer list with `or`.

```graphql
secret: String @rule(names: [["isOwner", "isVerified"], ["isAdmin"]])
# (isOwner AND isVerified) OR isAdmin
```

A single group is the common case: `@rule(names: [["isAuthenticated"]])`.

The registry may hold any `CheckableRule` — one built by `rule()`,
`createCan()`, the combinators, or `accept` / `deny`. Rules that need the
resolver to decide (`createCan(...).onResult`, `scopeArgs`, `wrap`) are not
checkable and cannot be named from SDL; put those in a hand-written entry (see
[Composing with a hand-written map](#composing-with-a-hand-written-map)).

## Example

```ts
import { makeExecutableSchema } from '@graphql-tools/schema';
import { applyPermissions, createCan, createGraphQLAbility, rule } from '@vantreeseba/graphql-casl';
import { directiveTypeDefs, permissionsFromDirectives } from '@vantreeseba/graphql-casl-directives';

const typeDefs = /* GraphQL */ `
  type Query {
    me: User @can(action: "read")
    notes: [Note!]! @can(action: "read")
    version: String
  }

  type Mutation {
    updateNote(id: ID!, body: String!): Note @can(action: "update")
    purge: Boolean @rule(names: [["isAdmin"]])
  }

  type User {
    id: ID!
    email: String @rule(names: [["isSelf"], ["isAdmin"]])
  }

  type Note @can(action: "read") {
    id: ID!
    body: String
    secret: String @rule(names: [["isOwner", "isVerified"], ["isAdmin"]])
  }
`;

const schema = makeExecutableSchema({
  typeDefs: [directiveTypeDefs, typeDefs],
  resolvers,
});

// Your createCan builder, exactly as for a hand-written map.
const canUser = createCan<Context, AppSubjectMap>(
  async (ctx) => buildAbilityFor(ctx),
  (ctx) => ctx.userId != null,
  typed,
);

// The rules @rule(names:) may name, keyed by the name used in the SDL.
const rules = {
  isAdmin: rule((_p, _a, ctx: Context) => ctx.roles?.includes('admin') || 'Admins only'),
  isSelf: rule((parent, _a, ctx: Context) => (parent as User).id === ctx.userId || 'Not you'),
  isOwner: rule((parent, _a, ctx: Context) => (parent as Note).userId === ctx.userId || 'Not yours'),
  isVerified: rule((_p, _a, ctx: Context) => ctx.verified === true || 'Verify your email'),
};

const permissions = permissionsFromDirectives(schema, { can: canUser, rules });

export const guarded = applyPermissions(schema, permissions);
```

With envelop, hand the same map to the plugin instead:

```ts
import { useGraphQLCasl } from '@vantreeseba/graphql-casl/envelop';

const plugins = [useGraphQLCasl({ permissions })];
```

### What lands where

The example translates to this map:

```ts
{
  Query: {
    me: canUser('read', 'User'),
    notes: canUser('read', 'Note'),
  },
  Mutation: {
    updateNote: canUser('update', 'Note'),
    purge: isAdmin,
  },
  User: {
    email: or(isSelf, isAdmin),
  },
  Note: {
    '*': canUser('read', 'Note'),
    secret: and(canUser('read', 'Note'), or(and(isOwner, isVerified), isAdmin)),
  },
}
```

- A directive on a **field** becomes that field's entry.
- A directive on an **object type** becomes the type's `'*'` entry. A field of
  that type with its own directive gets `and(typeRule, fieldRule)` — the runtime
  picks the most specific entry and never composes wildcards, so the translator
  composes for you.
- A directive on an **interface** is projected onto every implementing type,
  exactly as if it were written there. The runtime does not accept interface
  keys in a map. A `@can` on an interface with no `subject` checks the
  interface's name, since that is the type the directive is written on.
- **Several directives on one site** — two on a field, one on the type and one
  on the field, one on an interface and one on the implementor — compose with
  `and`, in SDL order. `extend type` directives count too.
- Fields with no directive get no entry, so the usual `fallbackRule` applies to
  them. Pass `fallbackRule: deny` to `applyPermissions` for deny-by-default.

### Problems are reported together

A schema with three mistakes reports all three, through the same
`PermissionsError` `applyPermissions` throws:

```
graphql-casl: the schema directives could not be translated.
  - `@can` on `Query.version` has no `subject` and none can be inferred: the field returns the scalar `String`. Name it, e.g. `@can(action: "read", subject: "...")`.
  - `@rule` on `Mutation.purge` names `isAdmn`, which is not in the rules registry.
  - `@can` on `Note.body` has an unknown `action` "publish"; expected one of "create", "read", "update", "delete", "manage".
```

Also reported: `@can` used without a `can` builder, `@rule` used without a
`rules` registry, a `names` that is not a non-empty list of non-empty lists, a
registry entry that is not a checkable rule, and a `@can` on a root *type*
(`type Query @can(...)`) with no `subject` — its fields return different
types, so there is nothing to infer.

## Composing with a hand-written map

`permissionsFromDirectives` returns a plain `PermissionsMap`, so anything the
directives cannot express goes in a hand-written entry next to it. Object
spread is shallow: a top-level type key in your object **replaces the whole
directive-derived entry for that type**, it does not merge with it. Spread the
type entry too.

```ts
const fromDirectives = permissionsFromDirectives(schema, { can: canUser, rules });

const permissions = {
  ...fromDirectives,
  Query: {
    ...fromDirectives.Query,
    // A rule that needs the resolver's result: not nameable from SDL.
    note: canUser.onResult('read', 'Note'),
  },
  Note: {
    ...fromDirectives.Note,
    // Let the ability's field list decide every field of Note.
    ...canUser.fields('read', 'Note'),
  },
};

applyPermissions(schema, permissions, { fallbackRule: deny });
```

Writing `Query: { note: ... }` without the inner spread would drop `me` and
`notes` — and, on a type with a type-level directive, its `'*'` entry.

## Limitations

- **No `@can` on a union.** The directives are declared on
  `FIELD_DEFINITION | OBJECT | INTERFACE`, so the SDL validator rejects a union
  site. Guard the fields that return the union, or each member type.
- **Conditions come from the ability, not the SDL.** `@can` is a possibility
  check (`ability.can(action, subject)`); which rows a caller may read is
  decided by the CASL rules you build in `createCan`, and a conditions-only
  grant is detected there. To check a specific instance, use
  `canUser.onResult` or a `getSubjectData` extractor in a hand-written entry.
- **Only the runtime's five actions.** `Action` is a closed union in
  `@vantreeseba/graphql-casl`; a custom action name is reported as a problem.
- **Only checkable rules in the registry.** `onResult`, `scopeArgs` and `wrap`
  rules cannot be named from SDL.
- **No `field` argument on `@can`.** `createCan`'s `fields` is a type-level
  entry, not a per-field check; spread `canUser.fields(...)` into the type
  entry as shown above.
- **The schema needs AST nodes.** Directives are read from `astNode` and
  `extensionASTNodes`, which `buildSchema`, `makeExecutableSchema` and
  `buildASTSchema` set. A schema built from `GraphQLObjectType` constructors
  carries no directives, so it translates to an empty map.

## License

[MIT](LICENSE) © Benjamin Van Treese
