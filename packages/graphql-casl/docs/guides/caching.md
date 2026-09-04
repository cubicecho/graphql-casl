# Caching a rule's answer

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

A rule attached to a *type* guards every field of it, so it runs **once per field
per object**: a 100-row list with 5 selected fields evaluates it 500 times. That
is free for a synchronous role check and expensive for the async rules this
library encourages — a [policy engine](./external-policy-engine.md)
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
[granted scope](./granted-scopes.md) skips the per-row
check altogether rather than caching it.
