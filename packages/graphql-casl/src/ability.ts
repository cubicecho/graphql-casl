/**
 * CASL action verbs and the minimal ability shape the rule layer depends on.
 *
 * The concrete typed ability lives in `./graphqlAbility.js`
 * ({@link GraphQLAbility} / {@link createGraphQLAbility}).
 */

/** The CASL action verbs supported by this middleware. */
export type Action = 'create' | 'read' | 'update' | 'delete' | 'manage';

/**
 * Const object holding every {@link Action} value — use instead of raw strings
 * in `can`/`cannot` calls and rule definitions to get autocomplete and catch
 * typos at compile time.
 *
 * The `satisfies` clause validates full coverage: TypeScript errors if `Action`
 * gains a new value and this object is not updated.
 */
export const Actions = {
  create: 'create',
  read: 'read',
  update: 'update',
  delete: 'delete',
  manage: 'manage',
} as const satisfies Record<Action, Action>;

/**
 * Minimal structural type for anything with a CASL-style `can` method — what the
 * rule layer needs to check an action against a subject. A typed
 * {@link GraphQLAbility} satisfies it; the method shape keeps type-checking for
 * consumers who annotate their ability with this type, unlike a `(...args: any[])`
 * shim.
 *
 * The optional third argument is CASL's field-level check
 * (`can('read', user, 'email')`), which `createCan(...).fields` uses to decide a
 * whole type's fields from the ability alone.
 */
export type AbilityLike = {
  // biome-ignore lint/suspicious/noExplicitAny: subject is opaque to the rule layer; the action stays type-checked
  can(action: Action, subject: any, field?: string): boolean;
};
