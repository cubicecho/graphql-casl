# Combining rules

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

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
rethrows it untouched. See [Error control](./error-control.md) — the table there is
the end-to-end behaviour, this paragraph is only about the rule layer.

A check's `context` is typed `any`, so a value outside that contract can still
reach the rule — `ctx.auth?.root` type-checks and is `undefined` when `auth` is
absent. Any such value is read for its truthiness, so `undefined` and `null`
deny with `Forbidden` rather than crashing the request. Return a `boolean` to
stay on contract; the coercion is a safety net, not a second supported form.

A check that is expensive — async, a round trip — can have its answer cached per
request or per row; see [Caching a rule's answer](./caching.md).

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
