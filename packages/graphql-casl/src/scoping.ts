/**
 * Argument scoping — the optional entry point,
 * `@vantreeseba/graphql-casl/scoping`.
 *
 * The rest of this library is a gate: a rule decides whether a field may be
 * resolved. That is the wrong shape for a generated CRUD field. `notes(where:)`
 * should not be denied outright because one row is off-limits — it should
 * return the rows the caller may read, and generated resolvers give you no
 * seam to call {@link accessibleBy} in.
 *
 * {@link scopeArgs} closes that gap from the outside: it folds the caller's
 * ability into a filter and **rewrites the field's arguments** before the
 * resolver runs, ANDing the scope onto whatever filter the client sent. The
 * resolver is untouched; it simply receives a narrower `where`.
 *
 * Two things to be clear-eyed about before using it:
 *
 * 1. **A scoped field returns fewer rows, not an error.** That is the point,
 *    but it means a caller cannot tell "no such row" from "not yours".
 * 2. **Injected arguments bypass GraphQL's input coercion.** A rule runs
 *    downstream of validation, so a filter in the wrong dialect is *not*
 *    rejected — it reaches the data layer as written, where it may be ignored
 *    and quietly widen access. Match the adapter to the schema's actual input
 *    type, and test it.
 *
 * @packageDocumentation
 */

import type { Action } from './ability.js';
import { accessibleBy } from './accessibleBy.js';
import type { FilterAdapter } from './conditions.js';
import type { RequireCan, RequireCanBare } from './createCan.js';
import type { GraphQLAbility } from './graphqlAbility.js';
import { CAN_INTERNALS, type CanInternals, SCOPE_INFO, type ScopeInfo } from './internal.js';
import { denialFrom, type Rule } from './rules.js';

/** What {@link scopeArgs} does when the ability permits no row at all. */
export type OnDenyAll = 'deny' | 'nothing';

/** Options for {@link scopeArgs}. */
export interface ScopeOptions<TFilter> {
  /**
   * The dialect to fold the ability's rules into. Must produce whatever the
   * target argument's input type actually accepts — see the coercion warning in
   * this module's description.
   */
  adapter: FilterAdapter<TFilter>;
  /**
   * The argument to inject the filter into. Default `'where'`.
   *
   * `applyPermissions` checks that the field really has an argument by this
   * name and refuses the map if it does not.
   */
  into?: string;
  /**
   * How to combine the caller's own filter with the scope. The default is a
   * top-level AND via the adapter — `adapter.and([clientFilter, scope])`.
   *
   * Override it only if the dialect needs a different combining shape. Do not
   * "merge" by spreading keys: a client filter of `{ OR: [...] }` sits beside
   * the scope's keys rather than under it, and the scope stops applying.
   */
  merge?: (clientFilter: unknown, scope: TFilter) => unknown;
  /**
   * What to do when the ability permits no row of this subject.
   *
   * - `'deny'` (default) — throw `Forbidden`. Honest, and the only safe choice
   *   for a mutation: a forbidden delete must fail, not silently match nothing.
   * - `'nothing'` — inject `adapter.nothing()` so the field resolves to an
   *   empty result. Requires the adapter to supply `nothing`.
   */
  onDenyAll?: OnDenyAll;
}

/** A `requireCan` from `createCan`, in either of its two shapes. */
export type Scopable<TSubjectMap extends Record<string, object>> =
  | RequireCan<TSubjectMap>
  | RequireCanBare<TSubjectMap>;

/**
 * A rule that narrows a field's filter argument to the rows the caller may
 * `action`, instead of allowing or denying the field outright.
 *
 * It is a plain {@link Rule}, not a `CheckableRule`: it decides by rewriting
 * arguments and calling the resolver, so it cannot be an operand of `and` /
 * `or` / `not` / `chain` / `race`. Use `wrap` to put a gate in front of it —
 * `wrap(isNotBanned, scopeArgs(...))` — or to stack it with `onResult`. Pair it
 * with `fallbackRule` too: a scoped field is not an authenticated-only field,
 * and scoping alone says nothing about the fields *around* it.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @typeParam TFilter - The dialect's filter type.
 * @param requireCan - The `requireCan` returned by `createCan`. Its
 * authentication check and per-request ability memo are reused, so a scoped
 * field costs no extra ability build.
 * @param action - The action to scope for, e.g. `Actions.read`.
 * @param subject - The subject name whose rows are being filtered, e.g. `'Note'`.
 * @param options - The dialect and where to put the filter. See {@link ScopeOptions}.
 * @example
 * ```ts
 * import { scopeArgs } from '@vantreeseba/graphql-casl/scoping';
 *
 * const permissions = {
 *   Query: {
 *     notes: scopeArgs(canUser, Actions.read, 'Note', { adapter: drizzleAdapter }),
 *   },
 * };
 * ```
 */
export function scopeArgs<
  TSubjectMap extends Record<string, object>,
  K extends keyof TSubjectMap & string,
  TFilter,
>(
  requireCan: Scopable<TSubjectMap>,
  action: Action,
  subject: K,
  options: ScopeOptions<TFilter>,
): Rule {
  const { adapter, merge } = options;
  const into = options.into ?? 'where';
  const onDenyAll = options.onDenyAll ?? 'deny';

  if (onDenyAll === 'nothing' && typeof adapter.nothing !== 'function') {
    throw new Error(
      "graphql-casl: `scopeArgs` with `onDenyAll: 'nothing'` needs an adapter that supplies " +
        '`nothing()` — the filter matching no row. Add it, or use the default `deny`.',
    );
  }

  const internals = (requireCan as Partial<Record<typeof CAN_INTERNALS, CanInternals<unknown>>>)[
    CAN_INTERNALS
  ];
  if (!internals) {
    throw new Error(
      'graphql-casl: `scopeArgs` expects the `requireCan` returned by `createCan`, so it can ' +
        "reuse that factory's authentication check and per-request ability.",
    );
  }

  // `accessibleBy` reports "no restriction" by *calling* `everything()`, and a
  // dialect's `everything()` is usually a fresh `{}` — indistinguishable from a
  // real filter by value. Swapping in one identity-comparable object makes the
  // unrestricted case detectable without deep equality. Safe because the fold
  // only ever returns `everything()` directly; it never combines it.
  const unrestricted = { graphqlCaslUnrestricted: true } as unknown as TFilter;
  const probe = { ...adapter, everything: () => unrestricted } as FilterAdapter<TFilter>;

  const scoped: Rule = async (resolve, parent, args, context, info) => {
    const ability = await internals.authorize(context);
    const filter = accessibleBy(
      ability as unknown as GraphQLAbility<TSubjectMap>,
      action,
      subject,
      probe,
    );

    if (filter === null) {
      if (onDenyAll === 'deny') {
        // Marked as a denial so `applyPermissions`' masking and error control
        // treat it like any other refusal.
        throw denialFrom(false) ?? new Error('Forbidden');
      }
      return resolve(parent, withArg(args, into, adapter.nothing?.()), context, info);
    }
    if (filter === unrestricted) return resolve(parent, args, context, info);

    const clientFilter = (args as Record<string, unknown> | null | undefined)?.[into];
    const combined =
      clientFilter === undefined || clientFilter === null
        ? filter
        : merge
          ? merge(clientFilter, filter)
          : adapter.and([clientFilter as TFilter, filter]);

    return resolve(parent, withArg(args, into, combined), context, info);
  };

  const info: ScopeInfo = { into: [into] };
  Object.defineProperty(scoped, SCOPE_INFO, { value: info });
  return scoped;
}

/** The field's args with one argument replaced. Never mutates the original. */
function withArg(args: unknown, name: string, value: unknown): Record<string, unknown> {
  const base = typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};
  return { ...base, [name]: value };
}
