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
 * in; a {@link FilterAdapter} swaps the dialect — a `SkeletonAdapter` replaces
 * the boolean combinators, a `LeafAdapter` replaces the comparisons as well.
 */

import type { MongoQuery } from '@casl/ability';
import type { Action } from './ability.js';
import { type FilterAdapter, ruleTranslator } from './conditions.js';
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

/** The default, mongo-style dialect. */
const mongoAdapter: FilterAdapter<AccessibleFilter<object>> = {
  rule: (conditions, inverted) =>
    inverted
      ? { $nor: [conditions as AccessibleFilter<object>] }
      : (conditions as AccessibleFilter<object>),
  and: (filters) => ({ $and: filters }),
  or: (filters) => ({ $or: filters }),
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
  // Either adapter kind, normalized to one `(conditions, inverted)` call.
  const translate = ruleTranslator(adapter);
  // A one-element group is the group itself. Worth doing here rather than in
  // each adapter: the common case is a single rule with a single condition, and
  // wrapping it in a pointless `or` forces every dialect to support one.
  const and = (filters: TFilter[]) =>
    filters.length === 1 ? (filters[0] as TFilter) : adapter.and(filters);
  const or = (filters: TFilter[]) =>
    filters.length === 1 ? (filters[0] as TFilter) : adapter.or(filters);
  const bounds: TFilter[] = [];
  const branches: TFilter[] = [];
  let unrestricted = false;

  for (const rule of rules) {
    if (rule.inverted) {
      // Nothing below an unconditioned `cannot` can be reached.
      if (!rule.conditions) break;
      bounds.push(translate(rule.conditions, true));
      continue;
    }
    if (!rule.conditions) {
      unrestricted = true;
      break;
    }
    const branch = translate(rule.conditions, false);
    branches.push(bounds.length > 0 ? and([branch, ...bounds]) : branch);
  }

  if (unrestricted) {
    if (bounds.length === 0) return adapter.everything();
    branches.push(and(bounds));
  }

  return branches.length > 0 ? or(branches) : null;
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
 * @example A leaf adapter, which translates the comparisons too:
 * ```ts
 * const prismaLeaves: FilterAdapter<object> = {
 *   leaf: ({ path, operator, value }) =>
 *     nest(path, { $eq: { equals: value }, $in: { in: value } }[operator] ?? value),
 *   not: (filter) => ({ NOT: filter }),
 *   and: (filters) => ({ AND: filters }),
 *   or: (filters) => ({ OR: filters }),
 *   everything: () => ({}),
 * };
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
/**
 * The filter matching every row of `subject` the ability permits `action` on,
 * in the dialect `adapter` describes, or `null` when it permits none.
 *
 * @typeParam TSubjectMap - The subject map, e.g. `SubjectMap<Resolvers, ResolversTypes>`.
 * @typeParam TFilter - The dialect's filter type.
 * @param ability - The caller's ability.
 * @param action - The action to filter for, e.g. `Actions.read`.
 * @param subject - The subject name to filter, e.g. `'Note'`.
 * @param adapter - The filter dialect. A `SkeletonAdapter` (one with `rule`)
 * controls only the combinators and passes conditions through as written; a
 * `LeafAdapter` (one with `leaf`) also receives each comparison individually.
 * @returns The filter, or `null` if no row is accessible.
 */
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
