# Delegating to an external policy engine

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

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
of times, and each one is a round trip. Set [`cache`](./caching.md)
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
the role [`accessibleBy`](./row-level-filtering.md) plays for CASL rules: fetch the
allowed ids first and filter the query, rather than resolving rows and denying
them one by one.

[openfga]: https://openfga.dev
[cerbos]: https://cerbos.dev
[opa]: https://www.openpolicyagent.org
[oso]: https://www.osohq.com
