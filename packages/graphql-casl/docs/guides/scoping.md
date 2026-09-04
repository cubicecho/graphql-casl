# Scoping generated resolvers (optional)

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

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
