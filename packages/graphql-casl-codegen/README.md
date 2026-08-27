# @vantreeseba/graphql-casl-codegen

A [GraphQL Code Generator](https://the-guild.dev/graphql/codegen) plugin that
emits [`@vantreeseba/graphql-casl`](../graphql-casl) subject bindings derived
from your schema, so you never hand-list domain type names.

## Install

```bash
npm install -D @vantreeseba/graphql-casl-codegen
# peer deps you already have for codegen
npm install -D @graphql-codegen/cli @graphql-codegen/typescript @graphql-codegen/typescript-resolvers
# the runtime the generated code imports from
npm install @vantreeseba/graphql-casl
```

## Usage

Run it **after** `typescript` + `typescript-resolvers` in the same output file —
it references the `Resolvers` / `ResolversTypes` they emit.

```ts
// codegen.ts
import type { CodegenConfig } from '@graphql-codegen/cli';

const config: CodegenConfig = {
  schema: './schema.graphql',
  generates: {
    'src/permissions.generated.ts': {
      plugins: ['typescript', 'typescript-resolvers', '@vantreeseba/graphql-casl-codegen'],
    },
  },
};

export default config;
```

### Generated output

For a schema with `User`, `Note`, and `Org` object types, the plugin appends:

```ts
import { createGraphQLAbility, createSubjects, createTyped, type SubjectMap } from '@vantreeseba/graphql-casl';

export type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;

export const Subject = createSubjects<AppSubjectMap>()({
  Note: 'Note',
  Org: 'Org',
  User: 'User',
} as const);

export const typed = createTyped<AppSubjectMap>();

export const ability = () => createGraphQLAbility<AppSubjectMap>();
```

Object, interface and union types all become subjects — `typescript-resolvers`
emits resolver entries for interfaces and unions too, so `SubjectMap` includes
them and the generated `Subject` const must match it. Root operation types
(`Query`/`Mutation`/`Subscription`) and introspection types are excluded, and
subjects are sorted for deterministic output. `createCan` stays in your app code
because it needs your `Context` and auth function.

## Configuration

All options are optional strings:

| Option | Default | Description |
|---|---|---|
| `importPath` | `@vantreeseba/graphql-casl` | Module the generated code imports from. |
| `subjectMapTypeName` | `AppSubjectMap` | Name of the generated subject-map type. |
| `subjectConstName` | `Subject` | Name of the generated subject-name const. |
| `typedName` | `typed` | Name of the generated `typed` tagger. |
| `abilityName` | `ability` | Name of the generated ability factory. |
| `resolversTypeName` | `Resolvers` | Name of the `Resolvers` type to reference. |
| `resolversTypesName` | `ResolversTypes` | Name of the `ResolversTypes` type to reference. |

```ts
'src/permissions.generated.ts': {
  plugins: ['typescript', 'typescript-resolvers', '@vantreeseba/graphql-casl-codegen'],
  config: { subjectConstName: 'Subjects', abilityName: 'buildAbility' },
},
```

## License

[MIT](LICENSE) © Benjamin Van Treese
