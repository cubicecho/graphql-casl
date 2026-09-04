# Enforcing the map through envelop (optional)

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

`applyPermissions` wraps a schema up front, which needs a schema you own and can
replace. That is awkward on Apollo Server 4+, on federated gateways, and anywhere
the schema is built or swapped for you. `useGraphQLCasl` hooks resolvers as
[envelop](https://the-guild.dev/graphql/envelop) hands them over, so the same map
works wherever envelop does: GraphQL Yoga, Apollo with the envelop integration,
Hive Gateway, `graphql-ws`.

```ts
import { createYoga } from 'graphql-yoga';
import { deny } from '@vantreeseba/graphql-casl';
import { useGraphQLCasl } from '@vantreeseba/graphql-casl/envelop';

const yoga = createYoga({
  schema,
  plugins: [
    useGraphQLCasl<Resolvers>({
      permissions,
      fallbackRule: deny,   // every option `applyPermissions` takes
      onDeny: 'filter',
    }),
  ],
});
```

`options.permissions` is the map; every other key is an
[`ApplyPermissionsOptions`](./error-control.md) field. Wildcard precedence,
`fallbackRule` coverage, error control and filtering all behave exactly as they
do under `applyPermissions` — the plugin calls `resolvePermissions` rather than
reimplementing any of it. Beyond that:

- **Filtered denials are reported for you.** Under `onDeny: 'filter'` the plugin
  merges each request's held denials into the result as execution finishes, so
  there is no `reportDenials` call to wire.

- **The map is validated when the schema arrives**, not on the first query that
  touches the offending field, so a map naming a type or field the schema does
  not have throws a `PermissionsError` while the server is being built. A schema
  swapped at runtime is re-validated and re-resolved.
- **Introspection is never guarded**, even under `fallbackRule: deny`.
- **A field with no resolver of its own is guarded too** — the default resolver
  is wrapped like any other, which is what makes a `canUser.fields(...)` rule on
  a plain object type work.
- **Each field is wrapped once**, however many times it resolves.

| | `applyPermissions` | `useGraphQLCasl` |
|---|---|---|
| Mechanism | wraps the schema via `graphql-middleware` | wraps resolvers via envelop |
| Needs a schema you can replace | yes | no |
| Works outside envelop | yes | no |
| Dynamic / swapped schemas | re-wrap yourself | handled |

Use one or the other, not both — two layers would run every rule twice.
