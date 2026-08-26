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
 * What a {@link Check} may return.
 *
 * `true` allows the field. `false` denies it with the default `Forbidden`
 * error, a `string` denies it with that message, and an `Error` is thrown as-is
 * — so a check can supply its own `GraphQLError` with extensions and a code.
 */
export type RuleResult = boolean | string | Error;

/**
 * The predicate behind a {@link CheckableRule}: the standard resolver arguments
 * *without* `resolve`, answering "may this field be resolved?".
 *
 * Because it cannot call the resolver, a check can be evaluated speculatively —
 * which is what lets {@link CheckableRule}s be combined.
 */
export type Check = (
  parent: unknown,
  args: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete context type
  context: any,
  info: GraphQLResolveInfo,
) => RuleResult | Promise<RuleResult>;

/**
 * A {@link Rule} that also exposes its decision as a standalone {@link Check}.
 *
 * A plain `Rule` denies by *throwing*, and the only way to ask it for a verdict
 * is to run it — which lets it call the resolver. A `CheckableRule` can be asked
 * without that side effect, so it can be an operand of `and` / `or` / `not` /
 * `chain` / `race`.
 *
 * Both forms remain valid map entries. Rules built by {@link rule}, by
 * `createCan`, and the {@link accept} / {@link deny} primitives are checkable;
 * hand-written middleware and `createCan(...).onResult` rules are not, because
 * they need the resolver to reach their decision.
 */
export interface CheckableRule extends Rule {
  /** The decision, callable without running the resolver. */
  readonly check: Check;
  /** A label used in combinator error messages. May be empty. */
  readonly ruleName: string;
}

/**
 * Normalizes a {@link RuleResult} into the error to throw, or `undefined` when
 * the check passed. Internal — shared with the combinators, not re-exported from
 * the package entry point.
 */
export function denialFrom(result: RuleResult): Error | undefined {
  if (result === true) return undefined;
  if (result === false) return new Error('Forbidden');
  if (typeof result === 'string') return new Error(result);
  return result;
}

/**
 * Wraps a {@link Check} into a {@link CheckableRule} — a rule usable directly in
 * a `PermissionsMap` *and* as an operand of the combinators.
 *
 * The check runs before the resolver; a denial throws and the resolver never
 * runs. An error raised *inside* the check propagates unchanged rather than
 * being converted into a denial, so a broken check is not silently mistaken for
 * a legitimate `Forbidden`.
 *
 * @param check - The predicate. See {@link RuleResult} for what it may return.
 * @param options - `name` labels the rule in combinator error messages.
 * @example
 * ```ts
 * const isSelf = rule(
 *   (parent, args: { id: string }, ctx) =>
 *     args.id === ctx.userId || 'You may only read your own profile',
 *   { name: 'isSelf' },
 * );
 * ```
 */
export function rule(check: Check, options?: { name?: string }): CheckableRule {
  const middleware: Rule = async (resolve, parent, args, context, info) => {
    const denial = denialFrom(await check(parent, args, context, info));
    if (denial) throw denial;
    return resolve(parent, args, context, info);
  };
  return Object.assign(middleware, {
    check,
    ruleName: options?.name ?? check.name ?? '',
  }) as CheckableRule;
}

/**
 * Narrows a {@link Rule} to a {@link CheckableRule}. The combinators use this to
 * reject an un-combinable operand at construction time rather than at request
 * time.
 */
export function isCheckableRule(value: unknown): value is CheckableRule {
  return typeof value === 'function' && typeof (value as CheckableRule).check === 'function';
}

/**
 * An always-pass {@link CheckableRule}: invokes the wrapped resolver
 * unconditionally. Use for public fields that need no authorization.
 */
export const accept: CheckableRule = rule(() => true, { name: 'accept' });

/**
 * An always-fail {@link CheckableRule}: denies with `Forbidden` without invoking
 * the resolver. Use to block a field for every caller.
 */
export const deny: CheckableRule = rule(() => false, { name: 'deny' });

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
