/**
 * Row-level filtering: turning a caller's ability into a *query filter*.
 *
 * The rest of this library is a gate — a rule allows or denies a whole field.
 * That is the wrong shape for a list: `notes` should not be denied outright
 * because one row is off-limits, it should return the rows the caller may read.
 * {@link accessibleBy} folds the ability's rules for one action and subject into
 * a boolean filter the resolver hands to its data layer, so the inaccessible
 * rows are never fetched in the first place.
 *
 * The filter is deliberately *not* tied to a database. The default is a
 * mongo-style tree, matching the operators CASL conditions are already written
 * in; a {@link FilterAdapter} swaps the boolean skeleton for another dialect.
 */

import type { MongoQuery } from '@casl/ability';
import type { Action } from './ability.js';
import type { GraphQLAbility } from './graphqlAbility.js';

/**
 * The default filter shape: one subject's CASL conditions, combined with
 * mongo's boolean operators.
 *
 * The leaves are the conditions exactly as written on the rules, so they are
 * typed against the subject's fields. Only the combining operators are added.
 *
 * @typeParam T - The subject type being filtered.
 */
export type AccessibleFilter<T> =
  | MongoQuery<T>
  | { $or: AccessibleFilter<T>[] }
  | { $and: AccessibleFilter<T>[] }
  | { $nor: AccessibleFilter<T>[] };

/**
 * Builds the filter dialect {@link accessibleBy} produces.
 *
 * CASL's rules are a priority-ordered switch; a query is flat boolean logic.
 * The adapter supplies the three combinators that translation needs, so the
 * fold itself stays dialect-agnostic.
 *
 * **The adapter controls the boolean skeleton, not the leaves.** A rule's
 * conditions are passed through as written, so a rule using CASL's mongo
 * operators (`{ status: { $in: [...] } }`) still yields `$in` in a Prisma-shaped
 * tree. Either write conditions in the target dialect's terms, or translate the
 * leaves inside `rule`.
 *
 * @typeParam TFilter - The filter type this dialect produces.
 */
export interface FilterAdapter<TFilter> {
  /**
   * One rule's conditions as a filter. An `inverted` rule (`cannot`) must come
   * back **negated** — it is a restriction, not a permission.
   */
  rule(conditions: object, inverted: boolean): TFilter;
  /** All of these must hold. */
  and(filters: TFilter[]): TFilter;
  /** Any of these may hold. */
  or(filters: TFilter[]): TFilter;
  /** The filter that matches every row — no restriction at all. */
  everything(): TFilter;
}

/** The default, mongo-style dialect. Single-element groups are not wrapped. */
const mongoAdapter: FilterAdapter<AccessibleFilter<object>> = {
  rule: (conditions, inverted) =>
    inverted
      ? { $nor: [conditions as AccessibleFilter<object>] }
      : (conditions as AccessibleFilter<object>),
  and: (filters) =>
    filters.length === 1 ? (filters[0] as AccessibleFilter<object>) : { $and: filters },
  or: (filters) =>
    filters.length === 1 ? (filters[0] as AccessibleFilter<object>) : { $or: filters },
  everything: () => ({}) as AccessibleFilter<object>,
};

/** The shape of a CASL rule, narrowed to what the fold reads. */
interface FoldableRule {
  readonly inverted?: boolean;
  readonly conditions?: object;
}

/**
 * Flattens CASL's priority-ordered rules into boolean logic.
 *
 * CASL evaluates rules highest-priority first and stops at the first match, so a
 * `can` only applies to rows no higher-priority `cannot` already caught. A query
 * has no such ordering, so each `can` becomes an `or` branch *bounded by* the
 * `cannot`s that outrank it. Rules already matched by an earlier branch are
 * absorbed by `or`, so higher-priority `can`s need no subtracting.
 *
 * Two rules end the walk: an unconditioned `cannot` denies everything below it,
 * and an unconditioned `can` permits everything below it.
 *
 * Implemented here rather than taken from `@casl/ability/extra` because that
 * helper is `rulesToQuery` on CASL 6 and `rulesToCondition` on 7, and the peer
 * range covers both.
 */
function fold<TFilter>(rules: readonly FoldableRule[], adapter: FilterAdapter<TFilter>) {
  const bounds: TFilter[] = [];
  const branches: TFilter[] = [];
  let unrestricted = false;

  for (const rule of rules) {
    if (rule.inverted) {
      // Nothing below an unconditioned `cannot` can be reached.
      if (!rule.conditions) break;
      bounds.push(adapter.rule(rule.conditions, true));
      continue;
    }
    if (!rule.conditions) {
      unrestricted = true;
      break;
    }
    const branch = adapter.rule(rule.conditions, false);
    branches.push(bounds.length > 0 ? adapter.and([branch, ...bounds]) : branch);
  }

  if (unrestricted) {
    if (bounds.length === 0) return adapter.everything();
    branches.push(adapter.and(bounds));
  }

  return branches.length > 0 ? adapter.or(branches) : null;
}

/**
 * The filter matching every row of `subject` the ability permits `action` on, or
 * `null` when it permits none.
 *
 * `null` is a decision, not an absence: it means *deny all*, and the resolver
 * should return an empty list without querying. Any other value — including
 * `{}`, which means "no restriction" — is a filter to pass to the data layer.
 *
 * Field-level rules are ignored; this answers which *rows* are reachable.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @param ability - The caller's ability.
 * @param action - The action to filter for, e.g. `Actions.read`.
 * @param subject - The subject name to filter, e.g. `'Note'`.
 * @param adapter - The filter dialect. Defaults to a mongo-style tree.
 * @returns The filter, or `null` if no row is accessible.
 * @example
 * ```ts
 * const filter = accessibleBy(ability, Actions.read, 'Note');
 * if (filter === null) return [];
 * return db.notes.find(filter);
 * ```
 * @example A Prisma-shaped dialect:
 * ```ts
 * const prismaFilter: FilterAdapter<object> = {
 *   rule: (conditions, inverted) => (inverted ? { NOT: conditions } : conditions),
 *   and: (filters) => ({ AND: filters }),
 *   or: (filters) => ({ OR: filters }),
 *   everything: () => ({}),
 * };
 *
 * const where = accessibleBy(ability, Actions.read, 'Note', prismaFilter);
 * return where === null ? [] : prisma.note.findMany({ where });
 * ```
 */
export function accessibleBy<
  TSubjectMap extends Record<string, object>,
  K extends keyof TSubjectMap & string,
>(
  ability: GraphQLAbility<TSubjectMap>,
  action: Action,
  subject: K,
): AccessibleFilter<TSubjectMap[K]> | null;
export function accessibleBy<
  TSubjectMap extends Record<string, object>,
  K extends keyof TSubjectMap & string,
  TFilter,
>(
  ability: GraphQLAbility<TSubjectMap>,
  action: Action,
  subject: K,
  adapter: FilterAdapter<TFilter>,
): TFilter | null;
export function accessibleBy<
  TSubjectMap extends Record<string, object>,
  K extends keyof TSubjectMap & string,
  TFilter,
>(
  ability: GraphQLAbility<TSubjectMap>,
  action: Action,
  subject: K,
  adapter?: FilterAdapter<TFilter>,
): TFilter | AccessibleFilter<TSubjectMap[K]> | null {
  // `rulesFor` takes the ability's own subject union; a bare subject name is a
  // member of it, but only after the map's generic is resolved.
  const rules = (ability.rulesFor as (a: Action, s: K) => readonly FoldableRule[])(action, subject);
  return adapter
    ? fold(rules, adapter)
    : (fold(rules, mongoAdapter) as AccessibleFilter<TSubjectMap[K]> | null);
}
