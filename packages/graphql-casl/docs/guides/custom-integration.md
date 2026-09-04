# Using the map without `graphql-middleware`

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

`applyPermissions` is `resolvePermissions` plus `graphql-middleware`.
`resolvePermissions` stops one step earlier and hands back the per-field lookup,
so the same map can be enforced through another integration — the [envelop entry
point](./envelop.md), an Apollo plugin, hand-wrapped resolvers — with identical wildcard
precedence, `fallbackRule` coverage, error control and filtering:

```ts
const permissionFor = resolvePermissions<Resolvers>(schema, permissions, options);

const rule = permissionFor(info.parentType.name, info.fieldName);
return rule
  ? rule(resolver, root, args, context, info)
  : resolver(root, args, context, info);
```

The map is validated up front exactly as `applyPermissions` validates it, and
lookups are memoized, so calling it per resolver call is cheap.

The [envelop integration](./envelop.md) is this pattern, already written.
