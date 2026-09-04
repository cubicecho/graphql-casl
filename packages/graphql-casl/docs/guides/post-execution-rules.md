# Post-execution rules

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

`canUser.onResult` runs the resolver first and checks the ability against **what
it returned**, so conditions are evaluated on the real record rather than on what
the client asserted. This is the direct fix for the IDOR shape warned about in
[step 3](../../README.md#3-declare-the-permissions-map).

```ts
export const permissions: PermissionsMap<Resolvers> = {
  Query: {
    // authorizes the Note the resolver actually loaded, not args.id
    note: canUser.onResult(Actions.read, Subject.Note),
  },
};
```

The resolved value is the subject data by default. Pass a `getSubjectData` to
unwrap it or to authorize a projection; it receives each candidate individually,
so a list calls it once per element.

```ts
notes: canUser.onResult(Actions.read, Subject.Note, (row: NoteRow) => ({
  userId: row.ownerId,
})),
```

Semantics worth knowing:

- **Lists are all-or-nothing.** Every element must pass or the whole field is
  denied. Filtering a list down to the permitted rows is a different operation.
- **`null` passes through.** There is no subject to authorize.
- **A tagger is required.** `onResult` needs `buildSubject` on `createCan` —
  resolved rows carry no `__typename`, so without it CASL cannot classify them.
  Calling `onResult` without one throws when the map is built, not at request time.

> ⚠️ **The resolver runs before the check.** That is inherent — the check needs
> the result — so this form is unsuitable for anything with side effects. A rule
> built with `onResult` therefore **refuses to guard a root mutation field**, and
> refuses it *before* calling the resolver, so the mutation never happens. For
> mutations, check the arguments up front with `canUser(...)`, or write a `Rule`
> by hand. Side-effecting *queries* (view counters and the like) are not detected
> — the same caution applies to them.
