# Validating arguments

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

GraphQL's input coercion checks *shape* — the right scalars in the right
places. It has nothing to say about a title that is blank, an end date before
its start, or a page size of ten million, so those checks end up hand-written at
the top of each resolver. `validateArgs` lifts them into the permissions map,
next to the authorization the same field needs.

It takes any [Standard Schema](https://standardschema.dev) — a zod (3.24+),
valibot, arktype or yup (1.7+) schema, or anything else with a `~standard`
property — so you bring the validator you already use and the package adds no
dependency:

```ts
import { validateArgs, wrap } from '@vantreeseba/graphql-casl';
import { z } from 'zod';

const CreateNoteArgs = z.object({
  input: z.object({
    title: z.string().trim().min(1, 'A note needs a title'),
    tags: z.array(z.string()).max(10).default([]),
  }),
});

const permissions = {
  Mutation: {
    createNote: wrap(canUser(Actions.create, Subject.Note), validateArgs(CreateNoteArgs)),
  },
} satisfies PermissionsMap<Resolvers>;
```

On success the resolver receives the schema's **parsed output** as its `args` —
`title` trimmed, `tags` defaulted — which is the point of running a schema
rather than a predicate. `ValidatedArgs<typeof CreateNoteArgs>` names that type.
Pass `{ replace: false }` to validate only and leave the arguments exactly as
GraphQL coerced them.

On failure the field rejects with a `GraphQLError` whose message lists the
issues, with `extensions.code: 'BAD_USER_INPUT'` and an `extensions.issues`
array of `{ message, path }`:

```json
{
  "message": "input.title: A note needs a title",
  "path": ["createNote"],
  "extensions": {
    "code": "BAD_USER_INPUT",
    "issues": [{ "message": "A note needs a title", "path": ["input", "title"] }]
  }
}
```

That failure is **not a permission denial**, and [error control](./error-control.md)
treats it accordingly: `fallbackError` never rewords it, since it named its own
error; `debug` has nothing to reveal; and under `onDeny: 'filter'` it keeps
`BAD_USER_INPUT` rather than taking `UNAUTHORIZED_FIELD_OR_TYPE`. The one mode
that treats it like a denial is `onDeny: 'mask'`, which nulls the field and says
nothing — bad input then reads as a missing record, the trade-off `'mask'`
already makes everywhere. An error thrown by the validator *itself* is a rule
failure, not a validation result, and is replaced or revealed as one.

Three things to know:

- **It is not a gate**, and like `scopeArgs` it cannot be an operand of `and` /
  `or` / `not` / `chain` / `race` — it decides by rewriting arguments and calling
  the resolver. Compose it with `wrap`, and put the authorization rule *first*:
  a caller who may not run the field at all should learn that, not what is wrong
  with their input.
- **Rewritten arguments bypass GraphQL's coercion**, exactly as `scopeArgs`'s do.
  A transform that changes a value's *type* — a string into a `Date` — hands the
  resolver something the SDL never promised. Often that is the point; make sure
  the resolver expects it.
- **Coming from `graphql-shield`'s `inputRule`**: same idea, no yup dependency,
  and the parsed output reaches the resolver instead of being thrown away.
