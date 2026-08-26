# TODO

## Deferred from the initial version

- **Ready-made ability presets** — explore optional helpers for common
  ownership patterns (e.g. `ownsField('userId')`) so consumers write less
  boilerplate in their ability builders.

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
- **Error control** (`shield-parity` S6–S10) — `applyPermissions` takes
  `fallbackError` (Error, message or mapper; only replaces denials that did not
  name their own), `allowExternalErrors` and `debug`. A denial, a resolver error
  and a rule's own failure are told apart rather than collapsed. CASL
  `cannot(...).because('...')` reasons become the denial message.
- **Combinable rules and combinators** (`shield-parity` S1 + S16) — `rule(check)`
  wraps a predicate into a `CheckableRule`, and `and` / `or` / `not` / `chain` /
  `race` compose them. `createCan`'s pre-execution rules and `accept` / `deny`
  are checkable, so they compose too. A rule that needs the resolver to decide
  (hand-written middleware, `onResult`) is rejected as an operand when the map is
  built, not at request time.
- **Parent-aware field rules.** `getSubjectData` now receives `(args, parent)`,
  so a field rule can condition on the parent object (`User.email` only when it
  is your own user) through the `createCan` builder instead of a hand-written
  `Rule`. Additive — single-argument extractors are unchanged.
- **Post-execution rules** (`ecosystem-parity` E1) — `canUser.onResult(action,
  subject, getSubjectData?)` runs the resolver and checks the ability against the
  value it returned, so conditions are evaluated on the real record instead of on
  a client-asserted arg. That closes the IDOR gap the README documents. It
  refuses root mutation fields *before* resolving, so no side effect escapes.
- **`applyPermissions` is a real schema walk**, not a cast: it validates the map
  against the runtime schema (`shield-parity` S13, aggregating every problem),
  supports `fallbackRule` (S2 / `ecosystem-parity` E9) and `'*'` wildcards in
  either position with graphql-authz's precedence (S3 / E8), and skips
  introspection types (S15).
- **`__isTypeOf` / `__resolveType` are excluded from `PermissionsMap`**
  (the sharp edge under `ecosystem-parity` E10) — rules attached to them never
  ran, and are now a compile error.

Note on fragments (`shield-parity` S5 / `ecosystem-parity` E2): the earlier plan
was to gate parent-aware rules behind fragment support, so the fields a rule
reads would be guaranteed present. **That guarantee is not available.** A probe
confirmed `graphql-middleware` extracts a rule's `fragment` into a
`fragmentReplacements` array on the returned schema and nothing else — the
selection set the parent resolver sees is unchanged. That array is only consumed
by graphql-tools *delegation*, not by plain execution. Shipping a `fragment`
option would therefore be an unkept promise, which is the failure mode this
library refuses everywhere else. Parent-aware rules shipped without it, with the
projecting-resolver caveat documented instead. Real selection-set injection has
to happen before execution — i.e. as part of the envelop plugin work
(`ecosystem-parity` E6).
