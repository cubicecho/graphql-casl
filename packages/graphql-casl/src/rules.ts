/**
 * The `graphql-middleware` integration layer: the {@link Rule} shape, the
 * {@link PermissionsMap} assembled from rules, and the {@link accept} / {@link deny}
 * primitives.
 */

import type { GraphQLResolveInfo, GraphQLSchema } from 'graphql';
import { applyMiddleware, type IMiddlewareTypeMap } from 'graphql-middleware';

type ResolveFn = (
  parent?: unknown,
  args?: unknown,
  context?: unknown,
  info?: GraphQLResolveInfo,
  // biome-ignore lint/suspicious/noExplicitAny: resolver resolve() must return any
) => Promise<any>;

/**
 * The callable middleware form used in {@link PermissionsMap} entries.
 *
 * A rule receives the wrapped `resolve` function plus the standard resolver
 * arguments. It either calls `resolve(...)` to allow the field, or throws to
 * deny it. `createCan` produces rules that enforce CASL abilities;
 * {@link accept} and {@link deny} are the always-pass / always-fail primitives.
 */
export type Rule = (
  resolve: ResolveFn,
  parent: unknown,
  args: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete context type
  context: any,
  info: GraphQLResolveInfo,
  // biome-ignore lint/suspicious/noExplicitAny: resolver result is opaque to the rule
) => Promise<any>;

/**
 * An always-pass {@link Rule}: invokes the wrapped resolver unconditionally.
 * Use for public fields that need no authorization.
 */
export const accept: Rule = (resolve, parent, args, context, info) =>
  resolve(parent, args, context, info);

/**
 * An always-fail {@link Rule}: throws `Forbidden` without invoking the resolver.
 * Use to block a field for every caller.
 */
export const deny: Rule = () => {
  throw new Error('Forbidden');
};

/**
 * Resolver-map keys that are *not* schema fields.
 *
 * `typescript-resolvers` emits `__isTypeOf` on object types and `__resolveType`
 * on interfaces and unions. They are abstract-type discriminators, not fields, so
 * `graphql-middleware` has nothing to wrap for them — a rule attached to one is
 * silently dead code. {@link PermissionsMap} excludes them so that mistake is a
 * compile error instead.
 */
type ResolverInternalKeys = '__isTypeOf' | '__resolveType';

/**
 * The permissions map applied to a schema via {@link applyPermissions}.
 *
 * Every key is validated against your generated `Resolvers`: type names come
 * from `keyof TResolvers` and field names from each type's resolver keys, so a
 * mistyped or unknown type/field is a compile error. Each type key is optional
 * and maps to either a single {@link Rule} (applied to every field of the type)
 * or a per-field map of rules.
 *
 * The abstract-type discriminators `__isTypeOf` and `__resolveType` are excluded
 * from the field keys — `graphql-middleware` never wraps them, so a rule attached
 * to one would never run.
 *
 * Because the keys are validated this is structurally narrower than
 * `graphql-middleware`'s `IMiddlewareTypeMap`; pass it through
 * {@link applyPermissions} rather than `applyMiddleware` directly.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @example
 * ```ts
 * const permissions: PermissionsMap<Resolvers> = {
 *   Query: { me: canUser(Actions.read, Subject.User) },
 *   Mutation: { requestMagicLink: accept, deleteNotes: deny },
 * };
 * ```
 */
export type PermissionsMap<TResolvers> = {
  [TypeName in keyof TResolvers]?:
    | Rule
    | {
        [FieldName in Exclude<
          keyof NonNullable<TResolvers[TypeName]>,
          ResolverInternalKeys
        >]?: Rule;
      };
};

/**
 * Applies a {@link PermissionsMap} to an executable schema via `graphql-middleware`.
 *
 * Prefer this over calling `applyMiddleware` directly: `PermissionsMap` is
 * intentionally narrower than `IMiddlewareTypeMap` so it can validate type and
 * field names, and this helper performs the single widening cast at the boundary
 * so consumers never have to.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @param schema - The executable schema to guard.
 * @param permissions - The permissions map to enforce.
 * @returns The schema wrapped with the permission middleware.
 * @example
 * ```ts
 * const schema = applyPermissions<Resolvers>(makeExecutableSchema({ typeDefs, resolvers }), permissions);
 * ```
 */
export function applyPermissions<TResolvers>(
  schema: GraphQLSchema,
  permissions: PermissionsMap<TResolvers>,
): GraphQLSchema {
  return applyMiddleware(schema, permissions as IMiddlewareTypeMap);
}
