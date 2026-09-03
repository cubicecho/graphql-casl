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
 *
 * The declared return type is a promise, and a denial is always delivered as a
 * rejection. An *allowed* field, though, may hand back whatever `resolve`
 * returned — a plain value when the resolver is synchronous — exactly as a
 * GraphQL resolver may. Callers `await` the result, which handles both.
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
 *
 * A {@link Check}'s `context` is `any`, so a value outside this union can still
 * reach here — `ctx.auth?.root` is `any`, and `undefined` at runtime. Any such
 * value is read for its truthiness, which makes `undefined` and `null` deny with
 * the default `Forbidden` rather than crash. Return a `boolean` to stay on
 * contract; the coercion is a safety net, not a second supported form.
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
 * Marks an error as a rule's *denial* rather than a failure of the rule itself
 * or of the resolver beneath it. Those three are indistinguishable once they are
 * all just thrown errors, and `applyPermissions` has to treat them differently:
 * a denial is the system working, the other two are not.
 *
 * The value records whether the check named the error (a string or an `Error`)
 * or merely returned `false` — only the latter is replaced by a `fallbackError`,
 * since a rule that said what it meant should not be overruled.
 */
const DENIAL: unique symbol = Symbol.for('graphql-casl.denial');

/** How a denial's error was chosen. Internal. */
export type DenialKind = 'default' | 'explicit';

/**
 * Reads the denial marker off an error. `undefined` means the error is not a
 * denial — it came from a broken rule or from the resolver. Internal.
 */
export function denialKindOf(error: unknown): DenialKind | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as Record<symbol, DenialKind | undefined>)[DENIAL];
}

/**
 * Attaches the denial marker without making it visible to serialization.
 *
 * An already-marked error keeps its original kind: a combinator re-normalizes
 * the error its operand produced, and an operand that named its denial should
 * not be demoted to a replaceable default on the way out.
 */
function markDenial(error: Error, kind: DenialKind): Error {
  if (denialKindOf(error) !== undefined) return error;
  Object.defineProperty(error, DENIAL, { value: kind, enumerable: false, configurable: true });
  return error;
}

/**
 * Whether a {@link RuleResult} allows the field. The same reading as
 * {@link denialFrom}, without building the error — for a caller that is going
 * to mask the denial and never needs one. Internal.
 */
export function passes(result: RuleResult): boolean {
  if (result === true) return true;
  if (typeof result === 'string' || result instanceof Error) return false;
  return Boolean(result);
}

/**
 * Normalizes a {@link RuleResult} into the error to throw, or `undefined` when
 * the check passed. Internal — shared with the combinators, not re-exported from
 * the package entry point.
 */
export function denialFrom(result: RuleResult): Error | undefined {
  if (result === true) return undefined;
  if (typeof result === 'string') return markDenial(new Error(result), 'explicit');
  if (result instanceof Error) return markDenial(result, 'explicit');
  // Anything else is off-contract, and `Check`'s `any` context lets it compile.
  // Fall back to truthiness so an off-contract value denies rather than crashing
  // `markDenial` on a non-object — deny being the safe direction here.
  return result ? undefined : markDenial(new Error('Forbidden'), 'default');
}

/**
 * How long one rule may reuse a check's answer.
 *
 * The default is `'no_cache'`: a rule attached to a *type* runs once per field
 * per object, so a 100-row list with 5 selected fields evaluates it 500 times.
 * That is free for a synchronous role check and expensive for the async rules
 * this library encourages — a policy-engine round trip, a row load.
 *
 * - `'no_cache'` — evaluate every time. The safe default; a check that reads
 *   something mutable, or that must observe every field, needs this.
 * - `'contextual'` — once per request. Correct when the answer depends only on
 *   the context: `isAuthenticated`, `hasRole`, an org-membership lookup.
 * - `'strict'` — once per request per `(parent, args)`. Correct when the answer
 *   depends on the row being authorized, and still collapses the *fields* of one
 *   row into a single evaluation. The field name is *not* part of the key: a
 *   check that reads `info.fieldName` needs `'no_cache'` or a {@link CacheKey}.
 *
 * A {@link CacheKey} function replaces `'strict'`'s key with one of your own.
 *
 * Caching is per rule and per request: entries hang off the context object in a
 * `WeakMap`, so they are unreachable once the request is. A context that is not
 * an object cannot be a `WeakMap` key, so such a rule is simply never cached.
 */
export type CacheMode = 'no_cache' | 'contextual' | 'strict';

/**
 * A custom cache key for {@link rule}'s `cache` option — the same escape hatch
 * `graphql-shield` offers when a function is passed as `cache`.
 *
 * The check is evaluated once per request per distinct key. Keys compare with
 * `Map` semantics: primitives by value, objects by identity — so return a
 * string, a number, or the object whose identity you mean. Return `undefined`
 * to skip the cache for that call.
 *
 * Use it when the built-in `'strict'` key — parent identity plus the field's
 * arguments — is wrong in either direction: too coarse when the answer depends
 * on `info.fieldName`, too fine when rows from different parents share an
 * answer, e.g. a check that only cares about `parent.orgId`.
 *
 * @example
 * ```ts
 * const inOrg = rule(
 *   async (parent: { orgId: string }, _args, ctx) => ctx.orgs.has(parent.orgId),
 *   { name: 'inOrg', cache: (parent: { orgId: string }) => parent.orgId },
 * );
 * ```
 */
export type CacheKey = (
  parent: unknown,
  args: unknown,
  // biome-ignore lint/suspicious/noExplicitAny: accepts any concrete context type
  context: any,
  info: GraphQLResolveInfo,
) => unknown;

/** Whether a check's answer is still pending. Internal. */
export function isThenable<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
}

/** Whether a value can key a `WeakMap`. */
function isObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

/**
 * A stable key for a field's arguments, or `undefined` if none can be made.
 *
 * Arguments are GraphQL input values, so they are JSON-safe. Keys are sorted
 * because argument order is not guaranteed to be stable across executions, and
 * two orderings of the same arguments must share a cache entry. A field with no
 * arguments — most fields of most object types — is the common case, and the
 * `JSON.stringify` round trip is skipped for it.
 *
 * A value `JSON.stringify` rejects (a `BigInt` scalar, a cyclic custom scalar)
 * yields no key rather than an exception: the rule then runs uncached for that
 * call, which is correct and costs only the caching.
 */
function argsKey(args: unknown): string | undefined {
  if (args === null || args === undefined) return '';
  if (typeof args !== 'object') return String(args);
  if (!Array.isArray(args)) {
    let empty = true;
    for (const _ in args) {
      empty = false;
      break;
    }
    if (empty) return '';
  }
  try {
    return JSON.stringify(args, (_key, value) =>
      value === null || typeof value !== 'object' || Array.isArray(value)
        ? value
        : Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1))),
    );
  } catch {
    return undefined;
  }
}

/**
 * Wraps a check so that one request evaluates it at most once per cache key.
 *
 * The *pending promise* is stored rather than the resolved value, so concurrent
 * field resolutions on one list share a single in-flight call instead of
 * stampeding — which is the whole point on a rule that calls out to a policy
 * engine. A rejection is cached alongside, so a broken check fails the request
 * once rather than 500 times; the next request starts clean.
 *
 * A check that answers synchronously is stored as its value, so the cached
 * answer is handed back without a promise hop — and {@link rule} then resolves
 * the field synchronously too.
 */
function memoize(check: Check, mode: Exclude<CacheMode, 'no_cache'> | CacheKey): Check {
  type Answer = RuleResult | Promise<RuleResult>;

  function evaluate(parent: unknown, args: unknown, context: unknown, info: GraphQLResolveInfo) {
    const answer = check(parent, args, context, info);
    return isThenable(answer) ? Promise.resolve(answer) : answer;
  }

  if (mode === 'contextual') {
    // One slot per request; the parent and args are irrelevant by definition.
    const byContext = new WeakMap<object, Answer>();
    return (parent, args, context, info) => {
      // No object to hang the cache off — a request-scoped cache is not
      // available, so evaluate as if uncached rather than leaking entries into
      // a global map.
      if (!isObject(context)) return check(parent, args, context, info);
      const hit = byContext.get(context);
      if (hit !== undefined) return hit;
      const answer = evaluate(parent, args, context, info);
      byContext.set(context, answer);
      return answer;
    };
  }

  // 'strict' keys on the parent's identity and the field's arguments; a custom
  // key function keys on whatever it returns. Both share one shape: a map per
  // request, a map per parent (or per custom key), an answer per argument key.
  const keyOf = typeof mode === 'function' ? mode : undefined;
  const byContext = new WeakMap<object, Map<unknown, Map<string, Answer>>>();
  return (parent, args, context, info) => {
    if (!isObject(context)) return check(parent, args, context, info);

    const parentKey = keyOf ? keyOf(parent, args, context, info) : parent;
    const key = keyOf ? '' : argsKey(args);
    // `undefined` from either means "unkeyable": run uncached for this call.
    if (parentKey === undefined || key === undefined) return check(parent, args, context, info);

    let slot = byContext.get(context);
    if (!slot) {
      slot = new Map();
      byContext.set(context, slot);
    }
    let byArgs = slot.get(parentKey);
    if (!byArgs) {
      byArgs = new Map();
      slot.set(parentKey, byArgs);
    }
    const hit = byArgs.get(key);
    if (hit !== undefined) return hit;
    const answer = evaluate(parent, args, context, info);
    byArgs.set(key, answer);
    return answer;
  };
}

/** Options for {@link rule}. */
export interface RuleOptions {
  /** Labels the rule in combinator error messages. Defaults to the check's name. */
  name?: string;
  /**
   * Reuses the check's answer within a request: a {@link CacheMode}, or a
   * {@link CacheKey} function for a key of your own. Default `'no_cache'`.
   */
  cache?: CacheMode | CacheKey;
}

/**
 * Marks a rule whose middleware is exactly "run `.check`, then `resolve`" — the
 * ones {@link rule} builds. `applyPermissions` reads it to take a fast path that
 * asks the check directly, which a hand-written {@link CheckableRule} whose
 * middleware does more than that must not be given. Internal.
 */
export const PLAIN_RULE: unique symbol = Symbol.for('graphql-casl.plainRule') as never;

/**
 * Wraps a {@link Check} into a {@link CheckableRule} — a rule usable directly in
 * a `PermissionsMap` *and* as an operand of the combinators.
 *
 * The check runs before the resolver; a denial rejects and the resolver never
 * runs. An error raised *inside* the check propagates unchanged rather than
 * being converted into a denial, so a broken check is not silently mistaken for
 * a legitimate `Forbidden`.
 *
 * @param check - The predicate. See {@link RuleResult} for what it may return.
 * @param options - See {@link RuleOptions}.
 * @example
 * ```ts
 * const isSelf = rule(
 *   (parent, args: { id: string }, ctx) =>
 *     args.id === ctx.userId || 'You may only read your own profile',
 *   { name: 'isSelf' },
 * );
 * ```
 */
export function rule(check: Check, options?: RuleOptions): CheckableRule {
  const mode = options?.cache ?? 'no_cache';
  // Memoize the *check*, not the middleware: the combinators call `.check`
  // directly, so caching applied any higher up would not reach an operand.
  const cached = mode === 'no_cache' ? check : memoize(check, mode);
  const middleware: Rule = (resolve, parent, args, context, info) => {
    let answer: RuleResult | Promise<RuleResult>;
    try {
      answer = cached(parent, args, context, info);
    } catch (error) {
      // A check that broke still fails the field by rejection, as it always has.
      return Promise.reject(error);
    }
    // A synchronous answer skips the microtask an `await` would cost — on a
    // 100-row list with 5 guarded fields that is 500 promise hops — while a
    // denial is still delivered as a rejection, never a synchronous throw.
    if (!isThenable(answer)) {
      const denial = denialFrom(answer);
      return denial ? Promise.reject(denial) : resolve(parent, args, context, info);
    }
    return Promise.resolve(answer).then((result) => {
      const denial = denialFrom(result);
      if (denial) throw denial;
      return resolve(parent, args, context, info);
    });
  };
  return Object.assign(middleware, {
    check: cached,
    ruleName: options?.name ?? check.name ?? '',
    [PLAIN_RULE]: true,
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
 * The loose stand-in for a generated `Resolvers` type.
 *
 * `PermissionsMap<AnyResolvers>` accepts any type and field name, so the map
 * compiles without codegen. Nothing is lost at *runtime*: `applyPermissions`
 * walks the real schema and raises an aggregated `PermissionsError` for every
 * key that does not exist, so a stale key still fails — at startup rather than
 * at build.
 *
 * This is the intended starting point on a large generated CRUD schema
 * (Prisma/TypeGraphQL, Pothos CRUD, drizzle-graphql), where running
 * `typescript-resolvers` over the whole surface is a project of its own. Swap in
 * your generated `Resolvers` when you have them and the same map starts being
 * checked at compile time; it is an upgrade, not a precondition.
 *
 * It is also the **default** type argument, so omitting the generic entirely
 * gives this behaviour rather than a misleading inference error.
 *
 * @example
 * ```ts
 * const permissions: PermissionsMap<AnyResolvers> = {
 *   Query: { notes: canUser(Actions.read, Subject.Note) },
 * };
 * ```
 */
export type AnyResolvers = Record<string, Record<string, unknown>>;

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
 * @typeParam TResolvers - Your generated `Resolvers` type. Defaults to
 * {@link AnyResolvers}, which accepts any type and field name and leaves the
 * checking to `applyPermissions`'s runtime schema walk.
 * @example
 * ```ts
 * const permissions: PermissionsMap<Resolvers> = {
 *   Query: { me: canUser(Actions.read, Subject.User) },
 *   Mutation: { requestMagicLink: accept, deleteNotes: deny },
 *   Note: { '*': canUser(Actions.read, Subject.Note), id: accept },
 * };
 * ```
 */
export type PermissionsMap<TResolvers = AnyResolvers> = {
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
