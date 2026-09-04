# Error control

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

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

## Filtering denials

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

### Where filtered denials are reported

A nullable field carries its own report: it resolves to `null` and the error
sits at its path, which is how GraphQL delivers any field error. A non-null
list is different — `[]` cannot also be an error — so that denial is held per
request until `reportDenials` merges it into the finished result. Under
[envelop](./envelop.md) that happens for you.
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

## Denial reasons from CASL

A `cannot(...).because('...')` reason becomes the denial message:

```ts
can(Actions.update, Subject.Note, { userId });
cannot(Actions.update, Subject.Note, { locked: true }).because('That note is locked');
```

A caller updating a locked note of their own gets `That note is locked`;
everything else still gets `Forbidden`. CASL's own `ForbiddenError` would default
to `Cannot execute "update" on "Note"`, which tells an unauthorized caller a type
name, so the reason is read off the matched rule instead.
