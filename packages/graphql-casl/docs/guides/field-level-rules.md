# Field-level rules

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

A `PermissionsMap` key can be any type, not just `Query`/`Mutation`, so rules
attach to individual fields. A field rule's condition usually belongs to the
*parent* — "read `User.email` only when it's your own user" says nothing about
the field's args — so `getSubjectData` receives `parent` as its second argument:

```ts
import type { ParentOf } from '@vantreeseba/graphql-casl';
import type { UserResolvers } from './__generated__/resolvers.js';

export const permissions: PermissionsMap<Resolvers> = {
  User: {
    email: canUser(
      Actions.read,
      Subject.User,
      (_args, parent: ParentOf<UserResolvers['email']>) => ({ id: parent.id }),
    ),
  },
};
```

`parent` is additive — existing single-argument extractors are unaffected.

> ⚠️ **If your resolvers project by selection set, select what your rules read.**
> Under plain `graphql-js` execution a parent resolver returns its whole object,
> so a field rule reliably sees the fields it conditions on. That stops being
> true when the parent resolver narrows by `info` — a Prisma `select` built from
> the selection set, or schema delegation — because a field the client didn't
> request may be absent, and an absent field makes a CASL condition *fail*
> rather than error. Nothing can fix that from inside a rule: the parent has
> already resolved by the time a field rule runs. `graphql-middleware`'s
> `fragment` option does not help either — it populates a `fragmentReplacements`
> array for graphql-tools delegation and never reaches plain execution. Have the
> parent resolver select the fields your rules condition on.
