# Persisting rules (optional)

> Part of the [`@vantreeseba/graphql-casl` guides](../../README.md#guides).

Rules are plain JSON, so they can be stored in a database and loaded/cached at
startup. Read `builder.rules` (or `ability.rules`) to persist them, and rebuild
with `buildGraphQLAbility`:

```ts
import { buildGraphQLAbility, type GraphQLRule } from '@vantreeseba/graphql-casl';

// persist
const { can, build } = createGraphQLAbility<AppSubjectMap>();
can(Actions.update, Subject.Note, { userId });
await db.savePermissionRules(build().rules);

// load (per request or cached)
const rules: GraphQLRule<AppSubjectMap>[] = await db.loadPermissionRules();
const ability = buildGraphQLAbility<AppSubjectMap>(rules);
```

Rules in a database are edited outside the type system, and
`buildGraphQLAbility` accepts whatever it is given. A stale row does not error —
it silently never grants: a condition on a field that has since been renamed
matches no record, a subject that no longer exists is never asked about, and an
operator CASL does not know throws on the first `can()` that reaches it,
mid-request. `validateGraphQLRules` checks the rows against the runtime schema
and throws a `PermissionsError` naming every problem, so call it where the rules
are loaded — and in a test:

```ts
import { validateGraphQLRules } from '@vantreeseba/graphql-casl';

const rules = await db.loadPermissionRules();
validateGraphQLRules(schema, rules); // PermissionsError: Rule 3 (`update` on `Note`): condition field `ownr` is not a field of `Note`.
const ability = buildGraphQLAbility<AppSubjectMap>(rules);
```

Per rule it checks the shape (a string or string-array `action` and `subject`; a
boolean `inverted`, since CASL reads any truthy value — the string `"false"`
included — as a denial), that `action` is one of `Actions`, that `subject` is
`all` or an object type in the schema (not a root operation type, and not an
interface or union, which `__typename` detection can never match), that each of
`fields` is a field of the subject, and that `conditions` uses only operators
CASL's matcher supports and names only fields of the subject, following dotted
paths through object-typed fields. Condition *values* are not checked.

That last check assumes conditions name GraphQL fields. If your subjects are
database models — codegen `mappers` pointing `ResolversTypes` at your ORM types
— a rule may legitimately condition on a column the schema does not expose.
Pass `{ conditionFields: 'none' }` to check only the shape and operators of
conditions; subjects and `fields` are still checked, since those are schema
names either way.
