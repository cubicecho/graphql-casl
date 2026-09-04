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

- **[`.agents/arg-scoping.todo.txt`](../../.agents/arg-scoping.todo.txt)** — a
  rule that merges the ability's filter into a resolver's *own* filter argument,
  for generated CRUD schemas (drizzle-graphql, Prisma/Pothos CRUD) where you own
  no resolver to call `accessibleBy` from. Design worked out; not started. Two
  probed findings drive it: a `Rule` can already rewrite args, and rewritten args
  bypass GraphQL input coercion, so a bad filter fails silently at the data layer.

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
- **Row-level filtering** (`accessibleby.todo.txt`) — `accessibleBy(ability,
  action, subject, adapter?)` folds the ability's rules into a query filter so a
  list resolver fetches only accessible rows. Dialect-agnostic via
  `FilterAdapter`; `null` means deny-all.
- **Masking denials** (`ecosystem-parity` E4) — `applyPermissions`'s
  `maskDenials` resolves a denied field to `null`, or `[]` where the field is a
  non-null list, instead of throwing, so one unauthorized field no longer nulls
  the whole `data` payload through a non-null chain. Bounded by the schema: a
  non-null non-list field still throws. Only denials are masked; rule failures
  and resolver errors still surface.
- **Filtering denials** (`prior-art` A1) — `onDeny: 'reject' | 'filter' |
  'mask'` is the global mode, with `maskDenials` kept as the spelling of
  `'mask'`. `'filter'` is Apollo Router's partial-response contract: a denied
  field resolves to `null`/`[]` and is reported with
  `extensions.code: "UNAUTHORIZED_FIELD_OR_TYPE"` and its path, in `errors` or,
  under `report: 'extensions'`, in `extensions.authorizationErrors`. Denials a
  non-null list cannot carry are held per context for `reportDenials`, which the
  envelop plugin wires itself. `'reject'` stays the default until 2.0.
- **Field permissions driven by the ability** (`ecosystem-parity` E3) —
  `canUser.fields(action, subject)` attaches one rule to a type and decides each
  field with `ability.can(action, subject, info.fieldName)`, so a CASL rule's
  field list drives the map instead of being restated in it. Deny-by-default
  across that type's fields.
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
- **Rules on interfaces and unions** (`ecosystem-parity` E10, E8) — an
  interface entry in the map is inherited by every type implementing it,
  transitively, so a `Node` rule covers an implementor added later instead of
  being restated on each one; a union takes `'*'` for every member's fields.
  Precedence is stated in full — `T.f` > `I.f` > `T['*']` > `I['*']` > `'*'.f`
  > `'*'['*']` > `fallbackRule` — and two interfaces that both cover a field of
  one implementor are rejected as ambiguous until the implementor's own entry
  chooses. `PermissionsMap<Resolvers>` types an interface's keys from the fields
  `typescript-resolvers` emits on its resolver type.
- **`applyPermissions` is a real schema walk**, not a cast: it validates the map
  against the runtime schema (`shield-parity` S13, aggregating every problem),
  supports `fallbackRule` (S2 / `ecosystem-parity` E9) and `'*'` wildcards in
  either position with graphql-authz's precedence (S3 / E8), and skips
  introspection types (S15).
- **Stored rules are validated against the schema** (`prisma-schema-typing`
  P1) — `validateGraphQLRules(schema, rules, options?)` is the DB-rules
  counterpart of `validatePermissions`: subject names, `fields`, condition
  field paths and operators, and the rule's shape (a truthy non-boolean
  `inverted` silently turns a grant into a denial) are checked, every problem
  reported at once as a `PermissionsError`. Condition fields are checked
  against the schema by default; `conditionFields: 'none'` relaxes that for
  subjects that are database models with columns the schema does not expose.

- **Argument validation as a rule** (`shield-parity` S11) —
  `validateArgs(schema, options?)` is the `inputRule` counterpart, built on
  [Standard Schema](https://standardschema.dev) rather than yup: any zod
  (3.24+), valibot, arktype or yup (1.7+) schema works, the spec's interface is
  vendored, and the package stays zero-dep. On success the resolver receives
  the parsed output (defaults, coercion, transforms); `replace: false` validates
  only. On failure it rejects with a `GraphQLError` carrying
  `extensions.code: 'BAD_USER_INPUT'` and `extensions.issues`, marked as an
  explicit denial so `fallbackError` never rewords it and `onDeny: 'filter'`
  keeps its code. Plain `Rule`, like `scopeArgs`; composes through `wrap`.
- **The trust boundary, stated** (`prior-art` C2, E1, F1) — documented, not
  built. The README now says why a GraphQL-specific CASL binding exists at all
  (`__typename` is a schema-checked subject name, where `@casl/prisma` has to
  wrap every record in `subject()`), that ownership enforced in the data layer
  is strictly stronger than any resolver gate with this library as defense in
  depth on top of it, and that rooting authorized reads at `viewer`/`me`
  removes the IDOR class from the schema rather than guarding against it.

- **`__isTypeOf` / `__resolveType` are excluded from `PermissionsMap`**
  (the sharp edge under `ecosystem-parity` E10) — rules attached to them never
  ran, and are now a compile error.

- **A `graphql-shield` migration guide** (`shield-parity`) — the concept-mapping
  table plus the three differences that bite, chief among them that
  `allowExternalErrors` defaults to `true` here and `false` in shield, so a map
  ported verbatim starts surfacing resolver errors shield was masking.

- **Reaching an external policy engine** (`ecosystem-parity` E12) — documented,
  not built: a `rule()` check can await OpenFGA/Cerbos/OPA for the
  relationship-derived permissions CASL conditions cannot express, and compose
  with the ability-backed rules. The README covers the two things that are easy
  to get wrong — a PDP outage must not be reported as a denial, and the pending
  promise (not the resolved value) is what to cache per request.

- **An envelop/Yoga plugin** (`ecosystem-parity` E6) — the `/envelop` subpath
  export ([`src/envelop.ts`](./src/envelop.ts)) enforces the same map through
  envelop instead of `graphql-middleware`, for hosts where the schema cannot be
  wrapped up front (Apollo Server 4+, federation, dynamically swapped schemas).
  It shares `resolvePermissions` with `applyPermissions`, so the two integrations
  cannot drift. It shipped briefly as a separate `@vantreeseba/graphql-casl-envelop`
  package and was folded back in before that package was ever published.

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
to happen before execution — i.e. as part of the `/envelop` entry point
(`ecosystem-parity` E6), which sees resolvers early enough to do it.
