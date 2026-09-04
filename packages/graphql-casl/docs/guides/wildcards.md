# Wildcards

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

`'*'` works in either position. Wildcards never compose: exactly one rule guards a
field, and the most specific entry wins.

```ts
const permissions: PermissionsMap<Resolvers> = {
  Note: { '*': canUser(Actions.read, Subject.Note), id: accept },
  '*': { createdAt: deny },
};
```

From highest precedence to lowest:

| Entry | Matches |
| --- | --- |
| `{ Note: { body: rule } }` | a named field of a named type |
| `{ Note: { '*': rule } }` or `{ Note: rule }` | any field of a named type |
| `{ '*': { body: rule } }` | a named field of any type |
| `{ '*': { '*': rule } }` or `{ '*': rule }` | any field of any type |
| `fallbackRule` | everything else |

Field names under `'*'` are still checked — against every field in the schema, so a
typo that matches no type at all is an error.
