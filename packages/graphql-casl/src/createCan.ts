/**
 * The {@link createCan} factory — the central piece tying a CASL ability to the
 * `graphql-middleware` {@link Rule} layer.
 */

import type { AbilityLike, Action } from './ability.js';
import type { Rule } from './rules.js';

/**
 * What {@link createCan} does when a bare-subject check is made against a subject
 * whose only matching rules carry conditions.
 *
 * `ability.can('update', 'Note')` asks CASL *"is updating a Note possible at
 * all?"*, not *"may I update this Note?"* — a rule of
 * `can('update', 'Note', { userId })` makes the bare check return `true` for every
 * caller. Omitting `getSubjectData` there silently discards the conditions, with
 * no type error to catch it.
 *
 * - `'warn'` (default) — allow the check, but log once per rule. Non-breaking.
 * - `'throw'` — deny with an explanatory error. Recommended for new projects.
 * - `'allow'` — say nothing. For deliberate "is this possible at all" gates, e.g.
 *   guarding a list field whose rows are filtered inside the resolver.
 */
export type UnconditionedSubjectMode = 'warn' | 'throw' | 'allow';

/** Options for {@link createCan}. */
export interface CreateCanOptions {
  /**
   * How to handle a bare-subject check against a conditioned subject.
   * Default `'warn'`.
   *
   * @see {@link UnconditionedSubjectMode}
   */
  onUnconditionedSubject?: UnconditionedSubjectMode;
}

/**
 * The subset of CASL's `PureAbility` used to detect the conditioned-subject
 * footgun. Optional because {@link AbilityLike} only promises `can`, and a
 * hand-rolled ability may not implement it — in which case the check is skipped
 * rather than guessed at.
 */
type RuleIntrospection = {
  rulesFor?: (
    action: Action,
    subjectType: string,
  ) => ReadonlyArray<{ conditions?: unknown; inverted?: boolean }>;
};

/**
 * Whether every rule granting `action` on `subject` carries conditions, making a
 * bare-subject check a possibility test rather than a permission test.
 *
 * Conservative by design: returns `false` when the ability can't be introspected,
 * when no rule matches (the check denies anyway), or when any inverted (`cannot`)
 * rule is in play — a false positive here trains people to ignore the warning.
 */
function isUnconditionedCheck(ability: AbilityLike, action: Action, subject: string): boolean {
  const { rulesFor } = ability as AbilityLike & RuleIntrospection;
  if (typeof rulesFor !== 'function') return false;
  const rules = rulesFor.call(ability, action, subject);
  if (!rules || rules.length === 0) return false;
  return rules.every((rule) => rule.inverted !== true && rule.conditions != null);
}

function unconditionedMessage(action: Action, subject: string): string {
  return (
    `graphql-casl: \`can('${action}', '${subject}')\` was checked without \`getSubjectData\`, ` +
    `but every rule granting '${action}' on '${subject}' has conditions. A bare subject name ` +
    'asks CASL whether the action is possible at all, so the conditions are not evaluated and ' +
    'the check passes for every caller. Pass a `getSubjectData` extractor to check the actual ' +
    "subject, or set `onUnconditionedSubject: 'allow'` on `createCan` if the possibility check " +
    'is intentional (e.g. a list field whose rows are filtered in the resolver).'
  );
}

/**
 * A subject tagger, typically `createTyped`'s `typed`: turns a subject name plus
 * field values into a `__typename`-tagged instance CASL can classify.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export type BuildSubject<TSubjectMap extends Record<string, object>> = <
  K extends keyof TSubjectMap & string,
>(
  type: K,
  attrs: Partial<TSubjectMap[K]>,
) => unknown;

/**
 * The rule builder returned by {@link createCan} when a `buildSubject` tagger is
 * provided. Supports both bare-subject checks and condition checks where the
 * subject instance is built from resolver args via `getSubjectData`.
 *
 * The subject name `K` narrows `getSubjectData`'s return to that subject's fields
 * (`Partial<TSubjectMap[K]>`); annotate `getSubjectData`'s `args` parameter with
 * your generated `*Args` type to type the extraction end to end.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export type RequireCan<TSubjectMap extends Record<string, object>> = <
  K extends keyof TSubjectMap & string,
  TArgs extends Record<string, unknown> = Record<string, unknown>,
>(
  action: Action,
  subject: K,
  getSubjectData?: (args: TArgs) => Partial<TSubjectMap[K]>,
) => Rule;

/**
 * The rule builder returned by {@link createCan} when no `buildSubject` tagger is
 * provided. Only bare-subject checks are possible: `getSubjectData` is omitted
 * because, without a tagger, the built subject would carry no `__typename`, so
 * CASL could not classify it and every conditioned check would silently fail.
 * Pass a `buildSubject` to `createCan` to unlock condition checks.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export type RequireCanBare<TSubjectMap extends Record<string, object>> = <
  K extends keyof TSubjectMap & string,
>(
  action: Action,
  subject: K,
) => Rule;

/**
 * Factory that returns a `requireCan(action, subject, getSubjectData?)` rule
 * builder bound to a specific ability resolver and subject map.
 *
 * This decouples the auth/ability logic from the permissions map so projects can
 * swap in any ability-building strategy. The returned builder produces a
 * {@link Rule} that:
 *
 * 1. throws `Not authenticated` when `isAuthenticated` returns `false`;
 * 2. builds the request's ability via `getAbility`;
 * 3. throws `Forbidden` when the ability denies the action;
 * 4. otherwise calls the wrapped resolver.
 *
 * When `getSubjectData` and `buildSubject` are both supplied, the checked subject
 * is `buildSubject(subject, getSubjectData(args))` (e.g. a `typed()` instance);
 * with neither it is the bare subject-name string, which checks whether the
 * action is *possible* on that subject type rather than permitted on a specific
 * one — see {@link UnconditionedSubjectMode}.
 *
 * `getAbility` is called at most once per context object: every rule from a given
 * factory shares the result, so a query touching many guarded fields builds the
 * ability once. A rejected build is not cached.
 *
 * @typeParam TContext - Your resolver context type.
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @param getAbility - Builds the ability for a request's context. Memoized per context.
 * @param isAuthenticated - Returns whether the context represents a logged-in caller.
 * @param buildSubject - Optional subject constructor, typically `createTyped`'s `typed`.
 * @param options - Optional {@link CreateCanOptions}. May be passed in
 * `buildSubject`'s position when no tagger is used.
 * @returns A `requireCan(action, subject, getSubjectData?)` builder.
 * @example
 * ```ts
 * const canUser = createCan<Context, AppSubjectMap>(
 *   async (ctx) => defineAbilitiesFor(ctx.userId),
 *   (ctx) => ctx.userId != null,
 *   typed,
 * );
 *
 * // bare subject:
 * const readUser = canUser(Actions.read, Subject.User);
 * // subject instance built from args (annotate `args` to type the extraction):
 * const updateNote = canUser(Actions.update, Subject.Note, (args: MutationUpdateNoteArgs) => ({
 *   userId: args.userId,
 * }));
 * ```
 */
export function createCan<TContext, TSubjectMap extends Record<string, object>>(
  getAbility: (context: TContext) => Promise<AbilityLike>,
  isAuthenticated: (context: TContext) => boolean,
  buildSubject: BuildSubject<TSubjectMap>,
  options?: CreateCanOptions,
): RequireCan<TSubjectMap>;
export function createCan<TContext, TSubjectMap extends Record<string, object>>(
  getAbility: (context: TContext) => Promise<AbilityLike>,
  isAuthenticated: (context: TContext) => boolean,
  options?: CreateCanOptions,
): RequireCanBare<TSubjectMap>;
export function createCan<TContext, TSubjectMap extends Record<string, object>>(
  getAbility: (context: TContext) => Promise<AbilityLike>,
  isAuthenticated: (context: TContext) => boolean,
  buildSubjectOrOptions?: BuildSubject<TSubjectMap> | CreateCanOptions,
  maybeOptions?: CreateCanOptions,
): RequireCan<TSubjectMap> {
  const hasTagger = typeof buildSubjectOrOptions === 'function';
  const buildSubject = hasTagger ? buildSubjectOrOptions : undefined;
  const options = (hasTagger ? maybeOptions : buildSubjectOrOptions) ?? {};
  const onUnconditionedSubject = options.onUnconditionedSubject ?? 'warn';

  // One ability per context object, shared by every rule this factory produces.
  // A query touching 50 guarded fields otherwise rebuilds it 50 times. Keyed on
  // the context, which GraphQL creates per request, so entries die with it; the
  // WeakMap is per-`createCan` so two factories with different `getAbility`
  // implementations can't read each other's abilities.
  const abilityCache = new WeakMap<object, Promise<AbilityLike>>();

  function resolveAbility(context: TContext): Promise<AbilityLike> {
    // A non-object context (undefined, a string) can't key a WeakMap. Rare, but
    // it must still work — just without the memo.
    if (context === null || (typeof context !== 'object' && typeof context !== 'function')) {
      return Promise.resolve(getAbility(context));
    }
    const key = context as unknown as object;
    const cached = abilityCache.get(key);
    if (cached) return cached;
    const pending = Promise.resolve(getAbility(context));
    abilityCache.set(key, pending);
    // Don't let one failed build poison every later field on the same request.
    pending.catch(() => abilityCache.delete(key));
    return pending;
  }

  return function requireCan<
    K extends keyof TSubjectMap & string,
    TArgs extends Record<string, unknown> = Record<string, unknown>,
  >(action: Action, subject: K, getSubjectData?: (args: TArgs) => Partial<TSubjectMap[K]>): Rule {
    // Guards the footgun the overloads already forbid at the type level, for
    // callers reaching this via plain JS or a cast: a subject built without a
    // tagger has no `__typename`, so CASL can't classify it and the check would
    // silently deny every request. Fail loudly at map-construction time instead.
    if (getSubjectData && !buildSubject) {
      throw new Error(
        'createCan: `getSubjectData` requires a `buildSubject` tagger (e.g. `typed` from ' +
          '`createTyped`) to be passed to `createCan`; without it the subject has no ' +
          '`__typename` and CASL cannot match conditions.',
      );
    }
    // The conditions a bare check ignores are a property of the ability, which
    // only exists per request — so this can't be checked at construction time.
    // Warn at most once per rule instead of once per field resolution.
    let warned = false;
    return async (resolve, parent, args, context, info) => {
      if (!isAuthenticated(context)) {
        throw new Error('Not authenticated');
      }
      const ability = await resolveAbility(context);
      const instance =
        getSubjectData && buildSubject
          ? buildSubject(subject, getSubjectData(args as TArgs))
          : subject;

      if (
        !getSubjectData &&
        onUnconditionedSubject !== 'allow' &&
        isUnconditionedCheck(ability, action, subject)
      ) {
        if (onUnconditionedSubject === 'throw') {
          throw new Error(unconditionedMessage(action, subject));
        }
        if (!warned) {
          warned = true;
          console.warn(unconditionedMessage(action, subject));
        }
      }

      // `instance` is an opaque subject value or name here; the ability's `can`
      // is narrowly overloaded, so check through the loose AbilityLike shape.
      if (!ability.can(action, instance)) {
        throw new Error('Forbidden');
      }
      return resolve(parent, args, context, info);
    };
  };
}
