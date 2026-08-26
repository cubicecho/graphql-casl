# @vantreeseba/graphql-casl-envelop

An [envelop](https://the-guild.dev/graphql/envelop) plugin that enforces a
[`@vantreeseba/graphql-casl`](../graphql-casl) permissions map — without
`graphql-middleware`.

`applyPermissions` wraps a schema up front, which needs a schema you own and can
replace. That is awkward on Apollo Server 4+, on federated gateways, and
anywhere the schema is built or swapped for you. This plugin hooks resolvers as
envelop hands them over, so the same map works wherever envelop does: GraphQL
Yoga, Apollo with the envelop integration, Hive Gateway, `graphql-ws`.

## Install

```bash
npm install @vantreeseba/graphql-casl-envelop @vantreeseba/graphql-casl
# already present in any envelop/Yoga app
npm install @envelop/core graphql
```

## Usage

```ts
import { createYoga } from 'graphql-yoga';
import { Actions, deny } from '@vantreeseba/graphql-casl';
import { useGraphQLCasl } from '@vantreeseba/graphql-casl-envelop';
import { permissions } from './permissions.js';
import type { Resolvers } from './__generated__/resolvers.js';

const yoga = createYoga({
  schema,
  plugins: [
    useGraphQLCasl<Resolvers>({
      permissions,
      fallbackRule: deny,   // every option `applyPermissions` takes
      maskDenials: true,
    }),
  ],
});
```

The map, the rules, the ability and every option are the runtime package's —
see [its README](../graphql-casl/README.md). This package only changes *where*
the map is enforced.

## Behaviour

- **The map is validated when the schema arrives**, not on the first query that
  touches the offending field. A map naming a type or field the schema does not
  have throws a `PermissionsError` while the server is being built. A schema
  swapped at runtime is re-validated and re-resolved.
- **Introspection is never guarded**, even under `fallbackRule: deny`.
- **A field with no resolver of its own is guarded too** — the default resolver
  is wrapped like any other, which is what makes a `canUser.fields(...)` rule on
  a plain object type work.
- **Each field is wrapped once**, however many times it resolves.

Wildcard precedence, `fallbackRule` coverage, error control (`fallbackError`,
`allowExternalErrors`, `debug`) and `maskDenials` all behave exactly as they do
under `applyPermissions`: the plugin calls `resolvePermissions` from the runtime
package rather than reimplementing any of it.

## Choosing between this and `applyPermissions`

| | `applyPermissions` | `useGraphQLCasl` |
|---|---|---|
| Mechanism | wraps the schema via `graphql-middleware` | wraps resolvers via envelop |
| Needs a schema you can replace | yes | no |
| Works outside envelop | yes | no |
| Dynamic / swapped schemas | re-wrap yourself | handled |

Use one or the other, not both — two layers would run every rule twice.

## API

### `useGraphQLCasl<TResolvers>(options)`

`options.permissions` is the map; every other key is an
[`ApplyPermissionsOptions`](../graphql-casl/README.md#error-control) field.
Returns an envelop `Plugin`.

## License

[MIT](../../LICENSE) © Benjamin Van Treese
