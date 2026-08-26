# TODO

## Deferred from the initial version

- **Ready-made ability presets** — explore optional helpers for common
  ownership patterns (e.g. `ownsField('userId')`) so consumers write less
  boilerplate in their ability builders.

- **Parent-aware `createCan` for field-level rules** — `PermissionsMap`
  already supports field-level rules graphql-shield-style (keys are
  `keyof TResolvers`, not just root types, so `{ User: { email: rule } }`
  typechecks and `graphql-middleware` enforces it per-field). However,
  `createCan`'s `getSubjectData` hook only receives `args`, not the resolved
  `parent`. So a field rule conditioned on the parent object (e.g. "only read
  `User.email` when it's your own user") can't be expressed through the
  `createCan` builder today — it requires a hand-written `Rule`, which does
  receive `parent`. Consider a parent-aware variant, e.g.
  `getSubjectData(args, parent)`, so conditioned field-level checks work
  through the builder.

## Competitive gap analysis

Two analysis-only workstreams, recorded but not scheduled:

- **[`.agents/shield-parity.todo.txt`](../../.agents/shield-parity.todo.txt)** —
  what `graphql-shield` has that this does not (combinators, `fallbackRule`,
  wildcards, rule caching, fragments, error control), verified against shield's
  source. Includes a recorded design decision for the combinator work: an
  additive `CheckableRule` rather than redefining `Rule` as a predicate.

- **[`.agents/ecosystem-parity.todo.txt`](../../.agents/ecosystem-parity.todo.txt)** —
  ideas from `graphql-authz`, Pothos `scope-auth` and `@envelop/generic-auth`,
  plus CASL capabilities this library does not yet use. Several rank above
  shield parity, most notably **post-execution rules** (authorize the resolved
  entity rather than the client-asserted args).

- **[`.agents/prior-art.todo.txt`](../../.agents/prior-art.todo.txt)** — systems
  that solve authorization a *different* way: Apollo Router's federation auth
  directives, Cerbos/Oso query plans, `@casl/prisma`, data-layer pushdown, and
  the ancestors CASL was ported from. Less "what feature is missing" and more
  "is the shape right". Settles two open questions in the files above.

### Shipped from the analysis

A soundness pass, taken from the lists above:

- **Bare-subject checks no longer fail silently.** `ability.can(action, 'Note')`
  is a possibility check, so a conditions-only grant makes it pass for everyone.
  `createCan` now detects that at request time and warns once per rule;
  `onUnconditionedSubject: 'throw' | 'allow'` selects the other behaviours.
- **`getAbility` is memoized per context** (`shield-parity` S4a) — one ability
  per request shared across every rule from a factory, instead of one rebuild
  per guarded field.
- **`__isTypeOf` / `__resolveType` are excluded from `PermissionsMap`**
  (the sharp edge under `ecosystem-parity` E10) — rules attached to them never
  ran, and are now a compile error.

Note on "Parent-aware `createCan`" above: the blocker is not just the missing
`parent` argument. A parent-conditioned field rule is only sound if the fields
it reads are guaranteed to be in the selection set, which needs middleware
fragment support (`shield-parity` S5 / `ecosystem-parity` E2). Do them together.
