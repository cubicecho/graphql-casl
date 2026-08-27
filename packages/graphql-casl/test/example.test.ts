/**
 * Worked example: a tiny "todos" API secured with @vantreeseba/graphql-casl.
 *
 * This file doubles as runnable documentation. It shows every piece a real
 * consumer wires up, end to end:
 *
 *   1. the domain model + request context
 *   2. a CASL ability built per request
 *   3. createTyped / subjectsOf to tag and name subjects
 *   4. createCan to turn abilities into field rules
 *   5. a PermissionsMap + applyPermissions to guard the schema
 *
 * The generated `Resolvers` / `ResolversTypes` come from `./example.codegen.ts`
 * (a trimmed stand-in for `graphql-codegen` output); the subject map is derived
 * from them with `SubjectMap`, so nothing about the domain is hand-listed here.
 */

import { makeExecutableSchema } from '@graphql-tools/schema';
import { type GraphQLSchema, graphql } from 'graphql';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Actions,
  accept,
  applyPermissions,
  createCan,
  createGraphQLAbility,
  createTyped,
  deny,
  type GraphQLAbility,
  type PermissionsMap,
  type SubjectMap,
  subjectsOf,
} from '../src/index.js';
// These come from `graphql-codegen` in a real project — see example.codegen.ts.
import type { MutationSetDoneArgs, Resolvers, ResolversTypes, Todo } from './example.codegen.js';

// 1. Domain model + request context -----------------------------------------

// `Todo` is imported from the generated types above. The request context is
// app-defined (codegen doesn't know it), so it stays here.
interface Context {
  /** Set when the caller is authenticated; undefined for anonymous requests. */
  userId?: string;
}

const SEED: readonly Todo[] = [
  { id: 't1', ownerId: 'alice', title: 'buy milk', done: false },
  { id: 't2', ownerId: 'bob', title: 'walk dog', done: false },
];
let TODOS: Todo[];

// 2. The per-request CASL ability --------------------------------------------

// `SubjectMap` derives the subject types straight from the generated
// `Resolvers` / `ResolversTypes`: it drops root operations (Query/Mutation) and
// scalars, leaving `{ Todo: Partial<Todo> }` here — no manual type listing.
type AppSubjectMap = SubjectMap<Resolvers, ResolversTypes>;

// A schema-typed ability: `can`/`cannot` conditions are checked against the
// subject's fields, and `build()` wires `__typename` detection + the matcher.
type AppAbility = GraphQLAbility<AppSubjectMap>;

function defineAbilitiesFor(userId: string | undefined): AppAbility {
  const { can, build } = createGraphQLAbility<AppSubjectMap>();
  if (!userId) return build(); // no rules ⇒ anonymous callers can do nothing
  can(Actions.read, 'Todo'); // read any todo
  can(Actions.create, 'Todo'); // create todos
  can(Actions.update, 'Todo', { ownerId: userId }); // but only update your own
  return build();
}

// 3. Subjects: a typed tagger + a const of subject names ---------------------

// `typed` tags plain objects with __typename so CASL can classify them at
// runtime; `Subject` gives autocompleted, typo-proof subject-name literals,
// read straight off AppSubjectMap so there is no list to maintain. Both are
// optional conveniences — the bare name `'Todo'` is checked just as strictly,
// which is why the ability above uses it directly.
const typed = createTyped<AppSubjectMap>();
const Subject = subjectsOf<AppSubjectMap>();

// 4. createCan: bind the ability + auth check into a rule builder ------------

const canUser = createCan<Context, AppSubjectMap>(
  async (ctx) => defineAbilitiesFor(ctx.userId),
  (ctx) => ctx.userId != null,
  typed, // pass the tagger to enable condition checks (no cast needed)
);

// 5. Schema + resolvers ------------------------------------------------------

const typeDefs = /* GraphQL */ `
  type Query {
    todos: [Todo!]!
    health: String!
  }
  type Mutation {
    addTodo(title: String!): Todo!
    # ownerId is part of the input so the rule can check ownership from args
    # alone — middleware runs before the resolver and only sees parent/args/context.
    setDone(id: ID!, ownerId: ID!, done: Boolean!): Todo
    deleteAllTodos: Boolean
  }
  type Todo {
    id: ID!
    ownerId: ID!
    title: String!
    done: Boolean!
  }
`;

// Typing the resolver map as the generated `Resolvers<Context>` is exactly what
// a codegen consumer does — it checks every resolver against the schema.
const resolvers: Resolvers<Context> = {
  Query: {
    todos: () => TODOS,
    health: () => 'ok',
  },
  Mutation: {
    addTodo: (_parent, args, ctx): Todo => {
      const todo: Todo = {
        id: `t${TODOS.length + 1}`,
        ownerId: ctx.userId as string,
        title: args.title,
        done: false,
      };
      TODOS.push(todo);
      return todo;
    },
    setDone: (_parent, args) => {
      // The rule authorized `ownerId` (from args, before this resolver ran), so
      // the resolver MUST scope the write to that same `ownerId`. Looking up by
      // `id` alone would be an IDOR: a caller could pass their own `ownerId` (to
      // pass the check) but someone else's `id`. Middleware can't see the
      // to-be-loaded row, so the resolver enforces the row↔owner link.
      const todo = TODOS.find((t) => t.id === args.id && t.ownerId === args.ownerId);
      if (!todo) return null;
      todo.done = args.done;
      return todo;
    },
    deleteAllTodos: () => {
      TODOS = [];
      return true;
    },
  },
};

// 6. The permissions map -----------------------------------------------------

const permissions: PermissionsMap<Resolvers> = {
  Query: {
    todos: canUser(Actions.read, Subject.Todo),
    health: accept, // public field — runs without an auth check
  },
  Mutation: {
    addTodo: canUser(Actions.create, Subject.Todo),
    // Subject instance built from args (annotate `args` with the generated
    // `MutationSetDoneArgs`): callers may only flip their own todos.
    setDone: canUser(Actions.update, Subject.Todo, (args: MutationSetDoneArgs) => ({
      ownerId: args.ownerId,
    })),
    deleteAllTodos: deny, // wired but disabled for everyone
  },
};

let schema: GraphQLSchema;

beforeEach(() => {
  // Resolvers mutate TODOS in place; reset from the seed before each test.
  TODOS = SEED.map((t) => ({ ...t }));
  schema = applyPermissions<Resolvers>(makeExecutableSchema({ typeDefs, resolvers }), permissions);
});

function run(source: string, ctx: Context, variableValues?: Record<string, unknown>) {
  return graphql({ schema, source, contextValue: ctx, variableValues });
}

// 7. The behavior a consumer gets -------------------------------------------

const SET_DONE = `
  mutation ($id: ID!, $ownerId: ID!, $done: Boolean!) {
    setDone(id: $id, ownerId: $ownerId, done: $done) { id done }
  }
`;

describe('todos example', () => {
  it('lets a public field through without auth (accept)', async () => {
    const ctx = {};

    const result = await run('{ health }', ctx);
    expect(result.errors).toBeUndefined();
    expect(result.data?.health).toBe('ok');
  });

  it('blocks an anonymous read with "Not authenticated"', async () => {
    const ctx = {};

    const result = await run('{ todos { id } }', ctx);
    // todos is non-null ([Todo!]!), so the error bubbles up and nulls all data.
    expect(result.data).toBeNull();
    expect(result.errors?.[0]?.message).toBe('Not authenticated');
  });

  it('allows an authenticated read', async () => {
    const ctx = { userId: 'alice' };

    const result = await run('{ todos { id title } }', ctx);
    expect(result.errors).toBeUndefined();
    expect(result.data?.todos).toHaveLength(2);
  });

  it('lets an authenticated caller create a todo', async () => {
    const ctx = { userId: 'alice' };

    const result = await run('mutation { addTodo(title: "ship it") { id title } }', ctx);
    expect(result.errors).toBeUndefined();
    expect(result.data?.addTodo).toMatchObject({ title: 'ship it' });
    expect(TODOS).toHaveLength(3);
  });

  it('lets you complete your own todo (condition matches)', async () => {
    const ctx = { userId: 'alice' };
    const variables = { id: 't1', ownerId: 'alice', done: true };

    const result = await run(SET_DONE, ctx, variables);
    expect(result.errors).toBeUndefined();
    expect(result.data?.setDone).toMatchObject({ id: 't1', done: true });
  });

  it('forbids completing someone else’s todo (condition fails)', async () => {
    const ctx = { userId: 'alice' };
    const variables = { id: 't2', ownerId: 'bob', done: true };

    const result = await run(SET_DONE, ctx, variables);
    expect(result.data?.setDone).toBeNull();
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(TODOS.find((t) => t.id === 't2')?.done).toBe(false); // resolver never ran
  });

  it('does not let a forged ownerId reach someone else’s todo (IDOR)', async () => {
    // Attack: pass your own ownerId (so the check passes) but a victim's id.
    const ctx = { userId: 'alice' };
    const variables = { id: 't2', ownerId: 'alice', done: true }; // t2 is bob's

    const result = await run(SET_DONE, ctx, variables);
    // The gate passes (alice may update her own todos), but the resolver scopes
    // the write by ownerId, so bob's todo is never found or touched.
    expect(result.errors).toBeUndefined();
    expect(result.data?.setDone).toBeNull();
    expect(TODOS.find((t) => t.id === 't2')?.done).toBe(false);
  });

  it('always denies a field guarded by deny', async () => {
    const ctx = { userId: 'alice' };

    const result = await run('mutation { deleteAllTodos }', ctx);
    expect(result.data?.deleteAllTodos).toBeNull();
    expect(result.errors?.[0]?.message).toBe('Forbidden');
    expect(TODOS).toHaveLength(2); // resolver never ran
  });
});
