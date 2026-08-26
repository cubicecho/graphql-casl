/**
 * The {@link createCan} factory — the central piece tying a CASL ability to the
 * `graphql-middleware` {@link Rule} layer.
 */

import type { GraphQLResolveInfo } from 'graphql';
import type { AbilityLike, Action } from './ability.js';
import { CAN_INTERNALS, type CanInternals } from './internal.js';
import { type CheckableRule, denialFrom, type Rule, rule } from './rules.js';

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
/**
 * Reads the `reason` CASL attached to the rule that decided a check, so a
 * `cannot(...).because('...')` explanation reaches the caller instead of being
 * replaced by a generic `Forbidden`.
 *
 * CASL surfaces this through `ForbiddenError.from(ability).throwUnlessCan(...)`,
 * but that also rewrites the default message to `Cannot execute "x" on "Y"`,
 * which both changes this library's denial message and tells an unauthorized
 * caller the schema's type names. Reading the rule directly takes the reason
 * without the disclosure.
 */
function reasonFor(ability: AbilityLike, action: Action, subject: unknown): string | undefined {
  const { relevantRuleFor } = ability as AbilityLike & ReasonIntrospection;
  if (typeof relevantRuleFor !== 'function') return undefined;
  const reason = relevantRuleFor.call(ability, action, subject)?.reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

type ReasonIntrospection = {
  relevantRuleFor?: (action: Action, subject: unknown) => { reason?: unknown } | undefined;
};

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
 * The subject candidates in a resolved value: the value itself, or each non-null
 * element when the field resolved to a list. `null` yields none — a field that
 * resolved to nothing has no subject to authorize.
 */
function subjectsOf(result: unknown): unknown[] {
  if (result == null) return [];
  return Array.isArray(result) ? result.filter((item) => item != null) : [result];
}

/** Whether the guarded field is a root mutation field. */
function isMutationField(info: GraphQLResolveInfo): boolean {
  const mutationType = info.schema.getMutationType();
  return mutationType != null && info.parentType.name === mutationType.name;
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
 * `getSubjectData` also receives the resolver's `parent`, which is what a
 * field-level rule needs — "read `User.email` only when it is your own user" is a
 * condition on the parent `User`, not on the field's args. Annotate it with
 * `ParentOf<UserResolvers['email']>` to type it. See the caveat on
 * {@link createCan} about resolvers that project by selection set.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export interface RequireCan<TSubjectMap extends Record<string, object>> {
  <
    K extends keyof TSubjectMap & string,
    TArgs extends Record<string, unknown> = Record<string, unknown>,
    TParent = unknown,
  >(
    action: Action,
    subject: K,
    getSubjectData?: (args: TArgs, parent: TParent) => Partial<TSubjectMap[K]>,
  ): CheckableRule;

  /**
   * Builds a rule that authorizes the **resolved value** instead of the args.
   *
   * @see {@link RequireCanOnResult}
   */
  readonly onResult: RequireCanOnResult<TSubjectMap>;

  /**
   * Builds one rule that guards **every field of a type**, using CASL's
   * field-level permissions.
   *
   * @see {@link RequireCanFields}
   */
  readonly fields: RequireCanFields<TSubjectMap>;
}

/**
 * Builds a single rule that guards **every field of a type**, deciding each one
 * from CASL's field-level permissions rather than from a hand-written entry.
 *
 * `can('read', 'User', ['id', 'name'])` already says which fields may be read.
 * Restating that as a `PermissionsMap` entry per field duplicates it, and the two
 * drift. Attached to a type, this rule checks
 * `ability.can(action, subject, info.fieldName)` for whichever field is being
 * resolved, so one ability rule drives them all:
 *
 * ```ts
 * // abilities
 * can(Actions.read, Subject.User, ['id', 'name']);
 * can(Actions.read, Subject.User, ['email'], { id: userId }); // only your own
 *
 * // permissions map — one entry, every field of User guarded
 * User: canUser.fields(Actions.read, Subject.User),
 * ```
 *
 * The subject defaults to the resolver's `parent` — for a field of `User` that
 * is the `User` being read, which is what a field-level condition is about.
 * Supply `getSubjectData` to project it. A `buildSubject` tagger is required,
 * since the parent carries no `__typename`; when the parent is not an object
 * (a root `Query`/`Mutation` field) the check falls back to the bare subject
 * name, which asks whether the field is readable *at all*.
 *
 * A field with no matching rule is denied, so this is deny-by-default across the
 * type's fields — unlike the `PermissionsMap`, where an unnamed field is
 * unguarded.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 */
export type RequireCanFields<TSubjectMap extends Record<string, object>> = <
  K extends keyof TSubjectMap & string,
  TParent = unknown,
  TArgs extends Record<string, unknown> = Record<string, unknown>,
>(
  action: Action,
  subject: K,
  getSubjectData?: (parent: TParent, args: TArgs) => Partial<TSubjectMap[K]>,
) => CheckableRule;

/**
 * Builds a rule that runs the resolver first and authorizes what it returned.
 *
 * The pre-execution form checks what the **client asserted** — a condition built
 * from `args.userId` says nothing about the record the resolver actually loads,
 * which is how a caller passes their own `userId` alongside someone else's `id`.
 * This form has the real record in hand, so `can('read', typed('Note', note))`
 * evaluates the ability's conditions against the row that is about to be
 * returned. That is what CASL conditions are for.
 *
 * When the field resolves to a list, every element must pass or the whole field
 * is denied. Filtering a list down to the permitted rows is a different
 * operation, and is not what a gate does. A `null` result is returned as-is —
 * there is no subject to authorize.
 *
 * Without `getSubjectData` the resolved value *is* the subject data, which is the
 * common case. Supply one to pull the subject out of a wrapper, or to authorize
 * a projection of the record. It receives each candidate individually, so a list
 * calls it once per element, plus the resolver's `parent` as a second argument.
 *
 * A rule built this way is **not** a {@link CheckableRule}: its verdict requires
 * the resolved value, so it cannot be evaluated speculatively and the
 * combinators reject it as an operand.
 *
 * **The resolver runs before the check.** That is inherent — the check needs the
 * result. It makes this form unsuitable for anything with side effects, so a rule
 * built here refuses to guard a root mutation field, before the resolver runs
 * rather than after. For those, check the args up front with the pre-execution
 * form, or write a {@link Rule} by hand.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @example
 * ```ts
 * Query: {
 *   // authorizes the Note the resolver actually loaded, not `args.id`
 *   note: canUser.onResult(Actions.read, Subject.Note),
 * },
 * ```
 */
export type RequireCanOnResult<TSubjectMap extends Record<string, object>> = <
  K extends keyof TSubjectMap & string,
  TResult = unknown,
  TParent = unknown,
>(
  action: Action,
  subject: K,
  getSubjectData?: (result: TResult, parent: TParent) => Partial<TSubjectMap[K]>,
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
) => CheckableRule;

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
 * is `buildSubject(subject, getSubjectData(args, parent))` (e.g. a `typed()`
 * instance);
 * with neither it is the bare subject-name string, which checks whether the
 * action is *possible* on that subject type rather than permitted on a specific
 * one — see {@link UnconditionedSubjectMode}.
 *
 * **Caveat on `parent`.** Under plain `graphql-js` execution a parent resolver
 * returns its whole object, so a field rule reliably sees the fields it reads.
 * That stops being true when the parent resolver *projects by the selection set*
 * — a Prisma `select` built from `info`, or schema delegation — because a field
 * the client did not request may simply be absent, and an absent field makes a
 * CASL condition fail rather than error. Neither `graphql-middleware`'s
 * `fragment` option nor anything this library can do from inside a rule fixes
 * that: the parent has already resolved by the time a field rule runs. If your
 * resolvers project, have the parent select the fields your rules condition on.
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

  /** Shared prologue: authenticate, then get the request's ability. */
  async function authorize(context: TContext): Promise<AbilityLike> {
    if (!isAuthenticated(context)) {
      throw denialFrom('Not authenticated') ?? new Error('Not authenticated');
    }
    return resolveAbility(context);
  }

  function requireCan<
    K extends keyof TSubjectMap & string,
    TArgs extends Record<string, unknown> = Record<string, unknown>,
    TParent = unknown,
  >(
    action: Action,
    subject: K,
    getSubjectData?: (args: TArgs, parent: TParent) => Partial<TSubjectMap[K]>,
  ): CheckableRule {
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
    // A pre-execution check reaches its verdict without the resolver, so this is
    // a `rule()` rather than raw middleware — which is what makes it usable as an
    // operand of `and` / `or` / `not` / `chain` / `race`.
    return rule(
      async (parent, args, context) => {
        if (!isAuthenticated(context as TContext)) return new Error('Not authenticated');
        const ability = await resolveAbility(context as TContext);
        const instance =
          getSubjectData && buildSubject
            ? buildSubject(subject, getSubjectData(args as TArgs, parent as TParent))
            : subject;

        if (
          !getSubjectData &&
          onUnconditionedSubject !== 'allow' &&
          isUnconditionedCheck(ability, action, subject)
        ) {
          if (onUnconditionedSubject === 'throw') {
            return new Error(unconditionedMessage(action, subject));
          }
          if (!warned) {
            warned = true;
            console.warn(unconditionedMessage(action, subject));
          }
        }

        // `instance` is an opaque subject value or name here; the ability's `can`
        // is narrowly overloaded, so check through the loose AbilityLike shape.
        if (ability.can(action, instance)) return true;
        // A `cannot(...).because('...')` reason is the rule author's own words
        // for this denial; prefer it over the generic message.
        return reasonFor(ability, action, instance) ?? false;
      },
      { name: `can(${action}, ${subject})` },
    );
  }

  requireCan.fields = function fields<
    K extends keyof TSubjectMap & string,
    TParent = unknown,
    TArgs extends Record<string, unknown> = Record<string, unknown>,
  >(
    action: Action,
    subject: K,
    getSubjectData?: (parent: TParent, args: TArgs) => Partial<TSubjectMap[K]>,
  ): CheckableRule {
    if (!buildSubject) {
      throw new Error(
        'createCan: `fields` requires a `buildSubject` tagger (e.g. `typed` from ' +
          '`createTyped`) to be passed to `createCan`; without it the parent object has no ' +
          '`__typename` and CASL cannot classify it.',
      );
    }
    const tag = buildSubject;
    return rule(
      async (parent, args, context, info) => {
        if (!isAuthenticated(context as TContext)) return new Error('Not authenticated');
        const ability = await resolveAbility(context as TContext);

        // A root Query/Mutation field has no parent to be the subject. Fall back
        // to the bare name, which asks whether the field is readable at all.
        const instance =
          getSubjectData || (typeof parent === 'object' && parent !== null)
            ? tag(
                subject,
                getSubjectData
                  ? getSubjectData(parent as TParent, args as TArgs)
                  : (parent as Partial<TSubjectMap[K]>),
              )
            : subject;

        if (ability.can(action, instance, info.fieldName)) return true;
        return reasonFor(ability, action, instance) ?? false;
      },
      { name: `can(${action}, ${subject}, <field>)` },
    );
  };

  requireCan.onResult = function onResult<
    K extends keyof TSubjectMap & string,
    TResult = unknown,
    TParent = unknown,
  >(
    action: Action,
    subject: K,
    getSubjectData?: (result: TResult, parent: TParent) => Partial<TSubjectMap[K]>,
  ): Rule {
    // The resolved value has no `__typename` of its own to rely on — GraphQL
    // resolvers routinely return plain rows — so the tagger is required, not
    // optional as it is for the pre-execution form.
    if (!buildSubject) {
      throw new Error(
        'createCan: `onResult` requires a `buildSubject` tagger (e.g. `typed` from ' +
          '`createTyped`) to be passed to `createCan`; without it the resolved value has no ' +
          '`__typename` and CASL cannot classify it.',
      );
    }
    const tag = buildSubject;
    return async (resolve, parent, args, context, info) => {
      const ability = await authorize(context);

      // Checked before resolving, so the mutation does not run at all. Denying a
      // mutation after the fact would report a failure that already happened.
      if (isMutationField(info)) {
        throw new Error(
          `graphql-casl: \`onResult\` cannot guard the mutation field \`${info.parentType.name}.${info.fieldName}\`. ` +
            'It authorizes the resolved value, so the resolver — and its side effects — would ' +
            'have to run before the check could deny it. Check the arguments up front with ' +
            '`canUser(action, subject, getSubjectData)`, or write a `Rule` by hand.',
        );
      }

      const result = await resolve(parent, args, context, info);
      for (const candidate of subjectsOf(result)) {
        const data = getSubjectData
          ? getSubjectData(candidate as TResult, parent as TParent)
          : (candidate as Partial<TSubjectMap[K]>);
        const instance = tag(subject, data);
        if (!ability.can(action, instance)) {
          // Marked as a denial so the error-control and masking options in
          // `applyPermissions` can tell it apart from a rule that broke.
          const denial = denialFrom(reasonFor(ability, action, instance) ?? false);
          if (denial) throw denial;
        }
      }
      return result;
    };
  };

  // A private handle for the optional `scoping` entry point, which needs the
  // same authentication check and the same per-request ability memo but is not
  // a `requireCan` method — it lives behind a subpath export so the core
  // surface stays unchanged for anyone not using it.
  const internals: CanInternals<TContext> = { authorize };
  Object.defineProperty(requireCan, CAN_INTERNALS, { value: internals });

  return requireCan as RequireCan<TSubjectMap>;
}
