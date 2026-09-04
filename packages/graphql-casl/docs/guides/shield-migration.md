# Coming from `graphql-shield`

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

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
| a rule that *throws* inside `or` / `race` | same: it counts as a failed operand, so another branch can still pass — see [the throw column](./combining-rules.md) |
| — | `wrap(...rules)` has no shield equivalent: it nests rules as middleware, so rules that decide by running the resolver can still be composed |
| `allow` / `deny` | `accept` / `deny` |
| `fallbackRule: deny` | same option |
| `'*'` field key | `'*'` in **either** position, with [documented precedence](./wildcards.md) |
| `shield(someRule)` — one rule for the whole schema | `fallbackRule`, or `{ '*': someRule }` |
| `fallbackError` | same option — but it replaces only denials that did not name their own error |
| `allowExternalErrors` | same option, **opposite default** — see below |
| `debug` | same option |
| `ValidationError` for a rule on a field the schema lacks | `PermissionsError`, aggregating *every* problem in the map rather than the first |
| `cache: 'contextual' \| 'strict'` per rule | [same option, same three levels](./caching.md), same default (`'no_cache'`) — and `createCan` memoizes `getAbility(context)` per request on top |
| `cache: (parent, args, ctx, info) => key` | same escape hatch; returning `undefined` skips the cache for that call. No `hashFunction`: `'strict'` keys arguments with a built-in sorted-key stringifier rather than `object-hash` |
| unique rule names required (the cache is keyed by name) | not required — each rule instance owns its cache, so two rules named `isOwner` never share an answer |
| `inputRule` (yup-backed argument validation) | [`validateArgs(schema)`](./validating-arguments.md), taking any Standard Schema (zod, valibot, arktype, yup 1.7+) — no validator dependency, and the parsed output reaches the resolver |
| `rule({ fragment })` | not supported, deliberately — see [the note below](#three-differences-that-will-bite) |

## Three differences that will bite

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
[Field-level rules](./field-level-rules.md).

## What the port is for

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
[`onResult`](./post-execution-rules.md) evaluates the condition against the record
the resolver actually returned rather than the id the client asserted.
