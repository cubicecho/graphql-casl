/**
 * Simulated `graphql-codegen` output for the todos schema in `example.test.ts`.
 *
 * In a real project you do NOT hand-write this file — `@graphql-codegen/typescript`
 * + `typescript-resolvers` generate it from your `.graphql` schema, and you import
 * `Resolvers` / `ResolversTypes` / the `*Args` types wherever you build resolvers
 * or permissions. It is reproduced here (trimmed and lint-clean) so the example
 * shows the exact shapes those plugins emit. The real output additionally includes
 * a `ResolverWithResolve` union, `__isTypeOf`/`__resolveType` fields, and
 * subscription resolvers, all omitted here for brevity.
 */

import type { GraphQLResolveInfo } from 'graphql';

export type Maybe<T> = T | null;

/** GraphQL scalar → TypeScript mapping, as emitted by the `typescript` plugin. */
export type Scalars = {
  ID: { input: string; output: string };
  String: { input: string; output: string };
  Boolean: { input: boolean; output: boolean };
};

export type Todo = {
  __typename?: 'Todo';
  id: Scalars['ID']['output'];
  ownerId: Scalars['ID']['output'];
  title: Scalars['String']['output'];
  done: Scalars['Boolean']['output'];
};

export type Query = {
  __typename?: 'Query';
  todos: Array<Todo>;
  health: Scalars['String']['output'];
};

export type Mutation = {
  __typename?: 'Mutation';
  addTodo: Todo;
  setDone?: Maybe<Todo>;
  deleteAllTodos?: Maybe<Scalars['Boolean']['output']>;
};

export type MutationAddTodoArgs = {
  title: Scalars['String']['input'];
};

export type MutationSetDoneArgs = {
  id: Scalars['ID']['input'];
  ownerId: Scalars['ID']['input'];
  done: Scalars['Boolean']['input'];
};

export type ResolverTypeWrapper<T> = Promise<T> | T;

export type ResolverFn<TResult, TParent, TContext, TArgs> = (
  parent: TParent,
  args: TArgs,
  context: TContext,
  info: GraphQLResolveInfo,
) => Promise<TResult> | TResult;

export type Resolver<TResult, TParent = unknown, TContext = unknown, TArgs = unknown> = ResolverFn<
  TResult,
  TParent,
  TContext,
  TArgs
>;

export type RequireFields<T, K extends keyof T> = Omit<T, K> & {
  [P in K]-?: NonNullable<T[P]>;
};

export type ResolversTypes = {
  Query: ResolverTypeWrapper<Query>;
  Mutation: ResolverTypeWrapper<Mutation>;
  Todo: ResolverTypeWrapper<Todo>;
  ID: ResolverTypeWrapper<Scalars['ID']['output']>;
  String: ResolverTypeWrapper<Scalars['String']['output']>;
  Boolean: ResolverTypeWrapper<Scalars['Boolean']['output']>;
};

export type ResolversParentTypes = {
  Query: Query;
  Mutation: Mutation;
  Todo: Todo;
  ID: Scalars['ID']['output'];
  String: Scalars['String']['output'];
  Boolean: Scalars['Boolean']['output'];
};

export type QueryResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Query'] = ResolversParentTypes['Query'],
> = {
  todos?: Resolver<Array<ResolversTypes['Todo']>, ParentType, ContextType>;
  health?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
};

export type MutationResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Mutation'] = ResolversParentTypes['Mutation'],
> = {
  addTodo?: Resolver<
    ResolversTypes['Todo'],
    ParentType,
    ContextType,
    RequireFields<MutationAddTodoArgs, 'title'>
  >;
  setDone?: Resolver<
    Maybe<ResolversTypes['Todo']>,
    ParentType,
    ContextType,
    RequireFields<MutationSetDoneArgs, 'id' | 'ownerId' | 'done'>
  >;
  deleteAllTodos?: Resolver<Maybe<ResolversTypes['Boolean']>, ParentType, ContextType>;
};

export type TodoResolvers<
  ContextType = unknown,
  ParentType extends ResolversParentTypes['Todo'] = ResolversParentTypes['Todo'],
> = {
  id?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  ownerId?: Resolver<ResolversTypes['ID'], ParentType, ContextType>;
  title?: Resolver<ResolversTypes['String'], ParentType, ContextType>;
  done?: Resolver<ResolversTypes['Boolean'], ParentType, ContextType>;
};

export type Resolvers<ContextType = unknown> = {
  Query?: QueryResolvers<ContextType>;
  Mutation?: MutationResolvers<ContextType>;
  Todo?: TodoResolvers<ContextType>;
};
