# Field permissions from the ability

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

CASL rules already carry field lists — `can('read', 'User', ['id', 'name'])`.
Restating those as one `PermissionsMap` entry per field duplicates them, and the
two drift. `canUser.fields` attaches a single rule to a type and decides each
field from the ability:

```ts
// abilities
can(Actions.read, Subject.User, ['id', 'name']);
can(Actions.read, Subject.User, ['email'], { id: userId }); // only your own

// permissions map — one entry, every field of User guarded
export const permissions: PermissionsMap<Resolvers> = {
  Query: { me: canUser(Actions.read, Subject.User) },
  User: canUser.fields(Actions.read, Subject.User),
};
```

The subject is the resolver's `parent` — for a field of `User` that is the `User`
being read, which is what a field-level condition is about. Pass `getSubjectData`
to project it. On a root field, where there is no parent, the check degrades to
the bare subject name: "is this field readable at all".

Unlike the rest of the map, this is **deny-by-default across the type's fields**:
a field no ability rule mentions is denied rather than left unguarded. A
`buildSubject` tagger is required, since the parent carries no `__typename`.
