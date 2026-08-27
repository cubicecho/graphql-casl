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

The plugin appends:

```ts
import { createGraphQLAbility, createTyped, type SubjectMap, subjectsOf } from '@vantreeseba/graphql-casl';

export type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;

export const Subject = subjectsOf<AppSubjectMap>();

export const typed = createTyped<AppSubjectMap>();

export const ability = () => createGraphQLAbility<AppSubjectMap>();
```

No type name from your schema is written into that output: every binding hangs
off `AppSubjectMap`, which derives the names from `Resolvers` / `ResolversTypes`
at the type level. Object, interface and union types all become subjects —
`typescript-resolvers` emits resolver entries for interfaces and unions too, so
`SubjectMap` includes them — while root operation types
(`Query`/`Mutation`/`Subscription`), introspection types, scalars, enums and
inputs are not. Adding a type to the schema makes `Subject.NewType` available as
soon as `typescript-resolvers` picks it up.

`createCan` stays in your app code because it needs your `Context` and auth
function.

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
