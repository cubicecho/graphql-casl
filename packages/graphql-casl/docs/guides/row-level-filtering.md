# Row-level filtering

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

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

[drizzle-recipe]: ../../test/recipes/drizzleGraphql.ts

CASL evaluates rules in priority order and stops at the first match; a query has
no such ordering. Each `can` therefore becomes an `$or` branch bounded by the
`cannot`s that outrank it, which is why the output nests more than the rules
suggest. Field-level rules are ignored — this answers which *rows* are reachable.
