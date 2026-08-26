/**
 * The `graphql-middleware` rule layer: the {@link Rule} shape, the
 * {@link PermissionsMap} assembled from rules, and the {@link accept} / {@link deny}
 * primitives. Applying a map to a schema lives in `./applyPermissions.js`.
 */

import type { GraphQLResolveInfo } from 'graphql';

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
 * The wildcard key, usable in place of a type name or a field name in a
 * {@link PermissionsMap}.
 */
export type Wildcard = '*';

/** A type's guardable field names: its resolver keys, minus the discriminators. */
type FieldNamesOf<TFields> = Exclude<keyof NonNullable<TFields>, ResolverInternalKeys>;

/**
 * Every guardable field name in the schema. Used to type the field keys under a
 * wildcard type (`{ '*': { id: rule } }`), which are not tied to one type but
 * still have to name a field that exists somewhere.
 */
type AnyFieldName<TResolvers> = {
  [TypeName in keyof TResolvers]: FieldNamesOf<TResolvers[TypeName]>;
}[keyof TResolvers];

/**
 * The permissions map applied to a schema via `applyPermissions`.
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
 * {@link Wildcard} (`'*'`) is accepted in either position. Wildcards never
 * compose: exactly one rule guards a field, and the most specific entry wins.
 * From highest precedence to lowest:
 *
 * 1. `{ Note: { body: rule } }` — a named field of a named type
 * 2. `{ Note: { '*': rule } }` (or `{ Note: rule }`) — any field of a named type
 * 3. `{ '*': { body: rule } }` — a named field of any type
 * 4. `{ '*': { '*': rule } }` (or `{ '*': rule }`) — any field of any type
 *
 * Below all of those sits `applyPermissions`'s `fallbackRule` option, and below
 * that, no guard at all.
 *
 * @typeParam TResolvers - Your generated `Resolvers` type.
 * @example
 * ```ts
 * const permissions: PermissionsMap<Resolvers> = {
 *   Query: { me: canUser(Actions.read, Subject.User) },
 *   Mutation: { requestMagicLink: accept, deleteNotes: deny },
 *   Note: { '*': canUser(Actions.read, Subject.Note), id: accept },
 * };
 * ```
 */
export type PermissionsMap<TResolvers> = {
  [TypeName in keyof TResolvers | Wildcard]?:
    | Rule
    | {
        [FieldName in
          | (TypeName extends keyof TResolvers
              ? FieldNamesOf<TResolvers[TypeName]>
              : AnyFieldName<TResolvers>)
          | Wildcard]?: Rule;
      };
};
