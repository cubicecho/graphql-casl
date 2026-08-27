# Example

```ts
import {
  Actions,
  applyPermissions,
  createCan,
  createGraphQLAbility,
  createTyped,
  type GraphQLAbility,
  type PermissionsMap,
  type SubjectMap,
  subjectsOf,
} from '@vantreeseba/graphql-casl';
import type { MutationUpdateNoteArgs, Resolvers, ResolversTypes } from './__generated__/resolvers.js';

type Context = { userId?: string };
type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;
type AppAbility = GraphQLAbility<AppSubjectMap>;

const typed = createTyped<AppSubjectMap>();
const Subject = subjectsOf<AppSubjectMap>();

function defineAbilitiesFor(userId: string | undefined): AppAbility {
  const { can, build } = createGraphQLAbility<AppSubjectMap>();
  if (!userId) return build();
  can(Actions.read, Subject.Note);
  can(Actions.update, Subject.Note, { userId });
  return build();
}

const canUser = createCan<Context, AppSubjectMap>(
  async (ctx) => defineAbilitiesFor(ctx.userId),
  (ctx) => ctx.userId != null,
  typed,
);

const permissions: PermissionsMap<Resolvers> = {
  Query: {
    notes: canUser(Actions.read, Subject.Note),
  },
  Mutation: {
    updateNote: canUser(Actions.update, Subject.Note, (args: MutationUpdateNoteArgs) => ({
      userId: args.userId,
    })),
  },
};

const schema = applyPermissions<Resolvers>(executableSchema, permissions);
```
