# Granting a parent's decision to its fields

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

A list field that authorized its rows is followed, on every row, by a type rule
that authorizes them again — once per selected field.
[Caching](./caching.md) bounds that to once per row. A **granted
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
[caching table](./caching.md) measures:

| Rule on `Post` | CASL checks per request |
| --- | --- |
| `canUser.fields(Actions.read, Subject.Post)` | 500, one per field per row |
| conditioned `canUser(...)` with `cache: 'strict'` | 100, one per row |
| `race(granted('post'), canUser.fields(...))` | 1, on the list field |

Wall-clock, the difference is smaller than the counts suggest: a synchronous
CASL check already sits close to the unguarded graphql-js baseline, so the
grant mostly removes work that was cheap. Where it is not cheap — a
[policy engine](./external-policy-engine.md) round trip, a
conditioned check on a wide row, a `fields` rule whose ability has many rules —
the 500-to-1 is the whole point. `npm run bench` in the package prints the
current numbers side by side.
