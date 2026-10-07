/**
 * Type-level helpers derived from a consumer's generated `Resolvers` /
 * `ResolversTypes`. Pure types — no runtime, no internal dependencies.
 */

import type { GraphQLScalarType, OperationTypeNode } from 'graphql';

type RootOperations = Capitalize<`${OperationTypeNode}`>;

/**
 * Derives the domain type names from any generated `Resolvers` type by excluding:
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 *
 * @remarks
 * - Root operation types (`Query`, `Mutation`, `Subscription`)
 * - Custom scalar types (whose value is a `GraphQLScalarType` in `Resolvers`)
 *
 * The key remapping evaluates eagerly so consumers receive a concrete string
 * union, and `string &` ensures only string literal keys are retained.
 */
export type SubjectName<TResolvers> = string &
  keyof {
    [K in keyof TResolvers as K extends string
      ? K extends RootOperations
        ? never
        : NonNullable<TResolvers[K]> extends GraphQLScalarType
          ? never
          : K
      : never]: unknown;
  };

/**
 * Maps each domain name to a `Partial` of its model type via `TResolversTypes`.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @typeParam TResolversTypes - Your generated `ResolversTypes` type.
 *
 * @remarks
 * `Awaited<>` unwraps `ResolverTypeWrapper<T> = Promise<T> | T`, and `Partial<T>`
 * lets CASL conditions match any subset of the model's fields.
 */
export type SubjectMap<TResolvers, TResolversTypes> = {
  [K in SubjectName<TResolvers>]: K extends keyof TResolversTypes
    ? Partial<Awaited<TResolversTypes[K]>>
    : never;
};

/**
 * Extracts the parent (the object being resolved) from a generated resolver field.
 *
 * @typeParam TResolverField - A field of a generated `*Resolvers` type.
 *
 * @example
 * ```ts
 * type F = NoteResolvers['id'];
 * type P = ParentOf<F>; // Note
 * ```
 */
export type ParentOf<TResolverField> = TResolverField extends (
  parent: infer TParent,
  ...rest: unknown[]
) => unknown
  ? TParent
  : unknown;

/**
 * Extracts the args type from a generated resolver field. Falls back to
 * `Record<string, unknown>` for fields that take no args.
 *
 * @typeParam TResolverField - A field of a generated `*Resolvers` type.
 *
 * @example
 * ```ts
 * type M = MutationResolvers['updateUsers'];
 * type A = ArgsOf<M>; // MutationUpdateUsersArgs
 * ```
 */
export type ArgsOf<TResolverField> = TResolverField extends (
  parent: unknown,
  args: infer TArgs,
  ...rest: unknown[]
) => unknown
  ? TArgs
  : Record<string, unknown>;

/**
 * Extracts the context type from a generated resolver field.
 *
 * @typeParam TResolverField - A field of a generated `*Resolvers` type.
 *
 * @example
 * ```ts
 * type M = MutationResolvers['updateUsers'];
 * type C = ContextOf<M>; // Context
 * ```
 */
export type ContextOf<TResolverField> = TResolverField extends (
  parent: unknown,
  args: unknown,
  context: infer TContext,
  ...rest: unknown[]
) => unknown
  ? TContext
  : unknown;
