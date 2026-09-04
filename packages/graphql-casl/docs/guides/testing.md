# Testing your permissions

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

A guarded schema is just a schema, so rules are testable with `graphql()` and a
plain object for the context — no server, no transport, no mocking of this
library:

```ts
import { makeExecutableSchema } from '@graphql-tools/schema';
import { graphql } from 'graphql';
import { expect, it } from 'vitest';

const schema = applyPermissions<Resolvers>(
  makeExecutableSchema({ typeDefs, resolvers }),
  permissions,
);

const run = (source: string, ctx: Context) => graphql({ schema, source, contextValue: ctx });

it('refuses to complete someone else’s todo', async () => {
  const result = await run(
    'mutation { setDone(id: "t2", ownerId: "bob", done: true) { id } }',
    { userId: 'alice' },
  );

  expect(result.errors?.[0]?.message).toBe('Forbidden');
});
```

Three assertions are worth making that a passing/failing check alone does not
cover:

- **That the resolver never ran.** A rule that denies *after* the side effect
  has already happened still reports `Forbidden`, so asserting the error is not
  enough — assert the data is unchanged too.
- **The forged-argument case.** Pass your own owner id alongside another user's
  record id. The gate passes, so what you are testing is that the resolver
  scoped its lookup by the field the rule authorized. This is the
  [IDOR shape](../../README.md#3-declare-the-permissions-map), and it is the test most worth
  having.
- **The anonymous case for every public field.** `accept` and a missing map
  entry behave identically until you add `fallbackRule: deny`, at which point
  only the explicit `accept` still answers.

Because `applyPermissions` validates the map against the schema as it wraps it,
building the schema in a test is itself a check: a rule naming a field that no
longer exists throws a `PermissionsError` before any query runs. A single test
that only constructs the guarded schema will catch a whole class of drift.

If that is *all* a test wants, call `validatePermissions` instead. It runs the
same validation and throws the same aggregated `PermissionsError`, but builds no
middleware. If rules live in a database, `validateGraphQLRules` is the same
test for them (see [Persisting rules](./stored-rules.md)):

```ts
import { validateGraphQLRules, validatePermissions } from '@vantreeseba/graphql-casl';

it('names only fields that still exist', () => {
  expect(() => validatePermissions<Resolvers>(schema, permissions)).not.toThrow();
});

it('stored rules still match the schema', async () => {
  expect(() => validateGraphQLRules(schema, await db.loadPermissionRules())).not.toThrow();
});
```

The difference is cost. `applyPermissions` wraps a resolver for every guarded
field, so it is O(fields) — and with `fallbackRule` set, that is every field in
the schema. On a generated CRUD schema of 4,400 types and 35,200 fields,
`applyPermissions` takes ~1.6s where `validatePermissions` takes ~8ms. That cost
is paid once at startup, which is the right place for it; it is the wrong thing
to pay in every test file that only wants the drift check.
