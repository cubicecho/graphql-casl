# Rules on interfaces

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

An interface is a type key like any other. A rule under it guards that field on
every type implementing the interface — including one added to the schema after
the map was written, which is the point: a rule restated on each implementor
silently misses the next one.

```ts
const permissions: PermissionsMap<Resolvers> = {
  Node: { id: accept },                          // Note.id, User.id, and whatever implements Node next
  Searchable: canUser(Actions.read, Subject.Note), // every field of every Searchable
  Note: { body: canUser(Actions.read, Subject.Note) },
};
```

The field keys are the fields the interface declares — `Node: { body: rule }` is
an error, since `Node` has no `body` — but a type-wide `'*'` (or a bare rule)
on an interface covers every field of the implementor, declared on the interface
or not. Implementation is transitive: an interface that implements `Node` passes
`Node`'s rules on to its own implementors. A union takes only `'*'`, which guards
every field of every member; a named field on a union is an error, because a
union declares none. Either kind of entry guards the type wherever it is
reached: `Thing: rule` guards `Note`'s fields under `Query.note` as much as
under `Query.thing`.

An implementor's own entry beats the interface's, at the same tier — the
[precedence table](./wildcards.md) states the order. What the map never does is pick one of two inherited
rules for you: a `Note` implementing both `Node` and `Searchable`, where both
give a rule for `id` (or both give `'*'`) and `Note` does not, is ambiguous, and
`applyPermissions` rejects it with a `PermissionsError` naming both interfaces
until `Note` chooses. The same rule reached through two interfaces is fine.

With `typescript-resolvers`, the interface's resolver type lists its fields
alongside `__resolveType`, so `PermissionsMap<Resolvers>` checks the field keys
under `Node` at compile time exactly as it does under `Note` — and a union's
resolver type, which has only `__resolveType`, accepts only `'*'`. Under
`onlyResolveTypeForInterfaces: true` an interface accepts only `'*'` too; the
runtime walk still checks every key either way.
